// Runs and child workers (issue #34), black-box against a running Orrery. A scripted
// MCP client plays two harness conversations sharing one agent key, a child worker, a
// resume, and a model change; REST is then used to verify what was persisted and what a
// human sees. No server code is imported.
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
  const list: unknown = await res.json();
  const personal = asArray(list).find((workspace) => field(workspace, "kind") === "personal");
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
): Promise<string> {
  const res = await client.post("/api/agents/keys", {
    data: { agentId, workspaceId, validity: "90", projects: [] },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  const secret = requiredText(field(body, "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

// A fresh client per conversation: the MCP transport session id is never run identity.
async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: `orrery-runs-e2e-${randomUUID()}`, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

type CallResult = { isError: boolean; data: Record<string, unknown> };

async function checkin(client: Client, args: Record<string, unknown>): Promise<CallResult> {
  const result = await client.callTool({ name: "orrery_run_checkin", arguments: args });
  return { isError: result.isError === true, data: asRecord(result.structuredContent) };
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

test("two clients sharing a key stay distinct; resume reuses a run; children and model changes persist", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const agentId = await createAgent(api, `runs-e2e-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId);
  const a = await connect(secret);
  const b = await connect(secret);
  try {
    const sessionA = `conv-a-${randomUUID()}`;
    const first = await checkin(a, {
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: sessionA },
      model: "gpt-6.2-sol",
      harnessVersion: "0.171.0",
    });
    expect(first.isError).toBe(false);
    const runA = requiredText(field(first.data, "runId"), "run A id");
    expect(field(first.data, "model")).toBe("gpt-6.2-sol");

    const second = await checkin(b, {
      event: "run_started",
      runKey: { harness: "claude-code", nativeSessionId: `conv-b-${randomUUID()}` },
    });
    expect(second.isError).toBe(false);
    const runB = requiredText(field(second.data, "runId"), "run B id");
    expect(runB).not.toBe(runA);
    // No model was reported by client B: it stays unknown, never copied from A.
    expect(field(second.data, "model")).toBeNull();

    // A child worker reports on the parent's run with harness attribution only.
    const childId = `child-${randomUUID()}`;
    const child = await checkin(b, {
      event: "child_started",
      runId: runB,
      agentId: childId,
      agentType: "general-purpose",
    });
    expect(child.isError).toBe(false);
    expect(field(child.data, "runId")).toBe(runB);

    // A fresh handshake for the same native session id is a resume, not a new run.
    const resumedClient = await connect(secret);
    try {
      const resumed = await checkin(resumedClient, {
        event: "run_heartbeat",
        runKey: { harness: "codex", nativeSessionId: sessionA },
      });
      expect(resumed.isError).toBe(false);
      expect(field(resumed.data, "runId")).toBe(runA);
    } finally {
      await resumedClient.close();
    }

    // Model changes over a run are recorded; an absent report does not erase them.
    const changed = await checkin(a, { event: "run_heartbeat", runId: runA, model: "gpt-7" });
    expect(field(changed.data, "model")).toBe("gpt-7");
    const unchanged = await checkin(a, { event: "run_heartbeat", runId: runA });
    expect(field(unchanged.data, "model")).toBe("gpt-7");

    // Human view through REST: two runs, one child, one model change, and `unknown`
    // represented as null for the run that never reported a model.
    const listed = await api.get(`/api/workspaces/${workspaceId}/runs`);
    expect(listed.status()).toBe(200);
    const body: unknown = await listed.json();
    const runs = asArray(field(body, "runs"));
    const mine = runs.filter((run) => field(run, "agentId") === agentId);
    expect(mine).toHaveLength(2);
    const firstRun = mine.find((run) => field(run, "id") === runA);
    const secondRun = mine.find((run) => field(run, "id") === runB);
    expect(firstRun).toMatchObject({ harness: "codex", model: "gpt-7", status: "active" });
    expect(asArray(field(firstRun, "modelHistory"))).toHaveLength(1);
    expect(secondRun).toMatchObject({ harness: "claude-code", model: null });
    expect(asArray(field(secondRun, "children"))).toHaveLength(1);
    expect(field(asArray(field(secondRun, "children"))[0], "agentId")).toBe(childId);

    // A harness hook posting with the same key correlates to the same run over REST.
    const hook = await api.post("/api/runs/hook", {
      data: {
        schema: "orrery.run.hook.v1",
        event: "run_heartbeat",
        runKey: { harness: "codex", nativeSessionId: sessionA },
      },
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(hook.status()).toBe(200);
  } finally {
    await a.close();
    await b.close();
  }
});

test("the tool set is limited to project work and run reporting, with no lease or administration", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const agentId = await createAgent(api, `runs-tools-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId);
  const client = await connect(secret);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("orrery_run_checkin");
    expect(names).toContain("list_projects");
    for (const name of names) {
      expect(name).not.toMatch(/member|invit|workspace|access|setting|admin|grant|claim|lease/);
    }
    const denied = await checkin(client, { event: "run_heartbeat", runId: `run_${randomUUID()}` });
    expect(denied.isError).toBe(true);
    expect(field(denied.data, "code")).toBe("run_not_found");
  } finally {
    await client.close();
  }
});
