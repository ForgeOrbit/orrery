import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const run = promisify(exec);
const configuredBaseUrl = process.env.ORRERY_URL;
if (!configuredBaseUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl = configuredBaseUrl;

const composeFile =
  process.env.ORRERY_COMPOSE_FILE ?? new URL("../../compose.yaml", import.meta.url).pathname;
const postgresService = process.env.ORRERY_COMPOSE_POSTGRES ?? "postgres";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  const personal = (Array.isArray(list) ? list : []).find(
    (workspace) => field(workspace, "kind") === "personal",
  );
  return requiredText(field(personal, "id"), "the personal workspace id");
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name } });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the agent id");
}

async function issueKey(
  client: APIRequestContext,
  agentId: string,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  const res = await client.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(res.status()).toBe(201);
  const secret = requiredText(field(await res.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

async function project(client: APIRequestContext, workspaceId: string): Promise<string> {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Resume project ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the project id");
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: `orrery-resume-e2e-${randomUUID()}`, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

type CallResult = { isError: boolean; data: Record<string, unknown> };

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: asRecord(result.structuredContent) };
}

async function newRun(client: Client): Promise<string> {
  const result = await call(client, "orrery_run_checkin", {
    event: "run_started",
    runKey: { harness: "codex", nativeSessionId: randomUUID() },
  });
  expect(result.isError).toBe(false);
  return requiredText(field(result.data, "runId"), "the run id");
}

async function expireLease(issueId: string): Promise<void> {
  const sql =
    `UPDATE work_sessions SET lease_expires_at = statement_timestamp() - interval '1 second' ` +
    `WHERE issue_id = '${issueId}' AND status = 'active'`;
  await run(
    `docker compose -f "${composeFile}" exec -T ${postgresService} psql -U orrery -d orrery -c "${sql}"`,
    { timeout: 60_000 },
  );
}

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
});

test("interrupt, resume, reacquire and retry without duplicating a claim", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `resume-agent-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  let client = await connect(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Resumed issue" });
    expect(created.isError).toBe(false);
    const issueId = requiredText(field(asRecord(created.data.issue), "id"), "the issue id");
    const runId = await newRun(client);

    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    const sessionId = requiredText(field(claim.data.session, "id"), "the session id");
    expect(field(claim.data.session, "status")).toBe("active");
    const progress = await call(client, "report_progress", {
      issueId,
      summary: "Resumable progress",
    });
    expect(progress.isError).toBe(false);

    const live = await call(client, "resume_work_session", { issueId, runId });
    expect(live.isError).toBe(false);
    const liveResume = asRecord(live.data.resume);
    expect(field(liveResume, "disposition")).toBe("active");
    expect(field(asRecord(liveResume.session), "id")).toBe(sessionId);

    await client.close();
    client = await connect(secret);
    await expireLease(issueId);

    const interrupted = await call(client, "resume_work_session", { issueId, runId });
    expect(interrupted.isError).toBe(false);
    const interruptedResume = asRecord(interrupted.data.resume);
    expect(field(interruptedResume, "disposition")).toBe("expired");
    const expiredSession = asRecord(interruptedResume.session);
    expect(field(expiredSession, "id")).toBe(sessionId);
    expect(field(expiredSession, "status")).toBe("expired");
    expect(field(expiredSession, "progress")).toBe("Resumable progress");

    for (const stale of ["stop_session", "renew_claim", "report_progress"]) {
      const args: Record<string, unknown> =
        stale === "report_progress"
          ? { issueId, summary: "Stale overwrite", sessionId }
          : { issueId, sessionId };
      const result = await call(client, stale, args);
      expect(result.isError).toBe(true);
      expect(result.data).toMatchObject({ code: "session_required" });
    }
    const staleEdit = await call(client, "update_issue", { issueId, title: "Stale edit" });
    expect(staleEdit.isError).toBe(true);
    expect(staleEdit.data).toMatchObject({ code: "session_required" });

    const reacquired = await call(client, "reacquire_issue", { issueId, runId });
    expect(reacquired.isError).toBe(false);
    const reacquiredId = requiredText(field(reacquired.data.session, "id"), "the reacquired id");
    expect(reacquiredId).not.toBe(sessionId);
    expect(field(reacquired.data.session, "status")).toBe("active");
    expect(field(reacquired.data.session, "progress")).toBe("Resumable progress");

    const staleAfterReacquire = await call(client, "stop_session", {
      issueId,
      outcome: "completed",
      sessionId,
    });
    expect(staleAfterReacquire.isError).toBe(true);
    expect(staleAfterReacquire.data).toMatchObject({ code: "session_required" });
    const fencedRenew = await call(client, "renew_claim", { issueId, sessionId: reacquiredId });
    expect(fencedRenew.isError).toBe(false);
    expect(field(asRecord(fencedRenew.data.session), "id")).toBe(reacquiredId);

    const retry = await call(client, "reacquire_issue", { issueId, runId });
    expect(retry.isError).toBe(false);
    expect(field(retry.data.session, "id")).toBe(reacquiredId);
    const claimRetry = await call(client, "claim_issue", { issueId, runId });
    expect(claimRetry.isError).toBe(false);
    expect(field(claimRetry.data.session, "id")).toBe(reacquiredId);
    const sessions = await call(client, "list_work_sessions", { issueId });
    expect(sessions.isError).toBe(false);
    const active = asArray(sessions.data.sessions).filter(
      (session) => field(session, "status") === "active",
    );
    expect(active).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("a stale completion is refused when another worker now holds the issue", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const originalAgent = await createAgent(api, `stale-original-${randomUUID()}`);
  const replacementAgent = await createAgent(api, `stale-replacement-${randomUUID()}`);
  const originalSecret = await issueKey(api, originalAgent, workspaceId, projectId);
  const replacementSecret = await issueKey(api, replacementAgent, workspaceId, projectId);
  const original = await connect(originalSecret);
  const replacement = await connect(replacementSecret);
  try {
    const created = await call(original, "create_issue", { projectId, title: "Contested issue" });
    const issueId = requiredText(field(asRecord(created.data.issue), "id"), "the issue id");
    const originalRun = await newRun(original);
    const replacementRun = await newRun(replacement);

    const originalClaim = await call(original, "claim_issue", { issueId, runId: originalRun });
    expect(originalClaim.isError).toBe(false);
    const originalSessionId = requiredText(
      field(asRecord(originalClaim.data.session), "id"),
      "the original session id",
    );
    expect(
      (await call(original, "report_progress", { issueId, summary: "Original progress" })).isError,
    ).toBe(false);
    await expireLease(issueId);

    const claimed = await call(replacement, "claim_issue", { issueId, runId: replacementRun });
    expect(claimed.isError).toBe(false);
    expect(field(claimed.data.session, "status")).toBe("active");

    const reacquire = await call(original, "reacquire_issue", { issueId, runId: originalRun });
    expect(reacquire.isError).toBe(true);
    expect(reacquire.data).toMatchObject({ code: "issue_claimed" });
    for (const stale of ["stop_session", "renew_claim", "report_progress"]) {
      const args: Record<string, unknown> =
        stale === "report_progress"
          ? { issueId, summary: "Overwrite", sessionId: originalSessionId }
          : { issueId, sessionId: originalSessionId };
      const result = await call(original, stale, args);
      expect(result.isError).toBe(true);
      expect(result.data).toMatchObject({ code: "session_required" });
    }
    const staleEdit = await call(original, "update_issue", { issueId, title: "Stale title" });
    expect(staleEdit.isError).toBe(true);
    expect(staleEdit.data).toMatchObject({ code: "session_required" });

    const readBack = await call(replacement, "get_work_session", { issueId });
    expect(readBack.isError).toBe(false);
    expect(field(readBack.data.session, "status")).toBe("active");
    const sessions = await call(replacement, "list_work_sessions", { issueId });
    const active = asArray(sessions.data.sessions).filter(
      (session) => field(session, "status") === "active",
    );
    expect(active).toHaveLength(1);
    expect(field(active[0], "agentId")).toBe(replacementAgent);
  } finally {
    await original.close();
    await replacement.close();
  }
});
