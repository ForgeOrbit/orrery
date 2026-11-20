// Work sessions and renewable claims (issue #36), black-box against a running Orrery.
// A real MCP protocol client proves fenced agent writes are refused without a live session
// and allowed with one, while reads, creation, comments and knowledge stay unfenced. A
// second client races a claim; a bearer-only REST request checks the same public surface.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

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
  const personal = asArray(await res.json()).find(
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
    data: { name: `Session project ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the project id");
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: `orrery-sessions-e2e-${randomUUID()}`, version: "1" });
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

const bearer = (secret: string) => ({
  patch: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  post: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  get: (path: string) =>
    fetch(new URL(path, baseUrl), { headers: { authorization: `Bearer ${secret}` } }),
});

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

test("fenced writes need a live session; reads, creation, comments and knowledge do not", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-writer-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Fenced issue" });
    expect(created.isError).toBe(false);
    const issue = asRecord(created.data.issue);
    const issueId = requiredText(field(issue, "id"), "the issue id");

    // Unfenced reads and writes work with no claim at all.
    expect((await call(client, "get_issue", { issueId })).isError).toBe(false);
    expect((await call(client, "list_issues", { projectId })).isError).toBe(false);
    expect(
      (await call(client, "create_comment", { issueId, body: "No claim needed" })).isError,
    ).toBe(false);
    const knowledge = await call(client, "create_knowledge", { projectId, title: "Free note" });
    const entryId = requiredText(field(knowledge.data.entry, "id"), "the knowledge id");
    expect((await call(client, "update_knowledge", { entryId, body: "Still free" })).isError).toBe(
      false,
    );
    expect((await call(client, "ready_work", { projectId })).isError).toBe(false);

    // Fenced writes are refused without a session, over both transports, with one code.
    const unfencedMcp = await call(client, "update_issue", { issueId, title: "No session" });
    expect(unfencedMcp.isError).toBe(true);
    expect(unfencedMcp.data).toMatchObject({ code: "session_required" });
    const unfencedRest = await http.patch(`/api/issues/${issueId}`, { title: "No session" });
    expect(unfencedRest.status).toBe(409);
    expect(asRecord(await unfencedRest.json())).toMatchObject({ code: "session_required" });

    // A live session the agent holds allows the edit, close, reopen, progress and stop.
    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    expect(field(claim.data.session, "status")).toBe("active");
    expect((await call(client, "update_issue", { issueId, title: "With a session" })).isError).toBe(
      false,
    );
    expect((await call(client, "update_issue", { issueId, status: "closed" })).isError).toBe(false);
    expect((await call(client, "update_issue", { issueId, status: "open" })).isError).toBe(false);
    expect((await call(client, "renew_claim", { issueId })).isError).toBe(false);
    const progress = await call(client, "report_progress", { issueId, summary: "Halfway" });
    expect(progress.isError).toBe(false);
    expect(field(progress.data.session, "progress")).toBe("Halfway");
    const stopped = await call(client, "stop_session", { issueId, outcome: "completed" });
    expect(stopped.isError).toBe(false);
    expect(field(stopped.data.session, "status")).toBe("completed");

    // Progress survives the stop, and the fenced write is refused again once inactive.
    const readBack = await call(client, "get_work_session", { issueId });
    expect(field(readBack.data.session, "progress")).toBe("Halfway");
    const afterStop = await call(client, "update_issue", { issueId, title: "After stop" });
    expect(afterStop.isError).toBe(true);
    expect(afterStop.data).toMatchObject({ code: "session_required" });

    // REST exposes the same lifecycle with the same key.
    const restIssue = await call(client, "create_issue", { projectId, title: "REST session" });
    const restIssueId = requiredText(field(restIssue.data.issue, "id"), "the REST issue id");
    const restRun = await newRun(client);
    const restClaim = await http.post(`/api/issues/${restIssueId}/work-sessions`, {
      runId: restRun,
    });
    expect(restClaim.status).toBe(201);
    const restProgress = await http.post(`/api/issues/${restIssueId}/work-sessions/progress`, {
      summary: "REST progress",
    });
    expect(restProgress.status).toBe(200);
    const restEdit = await http.patch(`/api/issues/${restIssueId}`, { title: "REST edit" });
    expect(restEdit.status).toBe(200);
    const restStop = await http.post(`/api/issues/${restIssueId}/work-sessions/stop`, {
      outcome: "released",
    });
    expect(restStop.status).toBe(200);
  } finally {
    await client.close();
  }
});

test("ready work omits claimed issues and two claims yield one winner", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-racer-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const rival = await connect(secret);
  try {
    const first = await call(client, "create_issue", { projectId, title: "Raced issue" });
    const second = await call(client, "create_issue", { projectId, title: "Other issue" });
    const issueId = requiredText(field(first.data.issue, "id"), "the raced issue id");
    const otherId = requiredText(field(second.data.issue, "id"), "the other issue id");

    const before = await call(client, "ready_work", { projectId });
    expect(asArray(field(before.data, "issues")).map((item) => field(item, "id"))).toEqual(
      expect.arrayContaining([issueId, otherId]),
    );

    // Two distinct runs are two workers on the same issue; only one may claim it.
    const runA = await newRun(client);
    const runB = await newRun(rival);
    const [claimA, claimB] = await Promise.all([
      call(client, "claim_issue", { issueId, runId: runA }),
      call(rival, "claim_issue", { issueId, runId: runB }),
    ]);
    expect([claimA.isError, claimB.isError].filter((failed) => !failed)).toHaveLength(1);
    const refused = claimA.isError ? claimA : claimB;
    expect(refused.data).toMatchObject({ code: "issue_claimed" });

    const after = await call(client, "ready_work", { projectId });
    expect(asArray(field(after.data, "issues")).map((item) => field(item, "id"))).not.toContain(
      issueId,
    );
    expect(asArray(field(after.data, "issues")).map((item) => field(item, "id"))).toContain(
      otherId,
    );
  } finally {
    await client.close();
    await rival.close();
  }
});
