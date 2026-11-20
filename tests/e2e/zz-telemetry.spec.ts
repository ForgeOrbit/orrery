// #96 black-box proof: cumulative token/cost totals and v1 structured activity blocks over
// the real MCP protocol and the public REST API. Drives one agent loop end to end against a
// running Orrery image:
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

type CallResult = { isError: boolean; data: Record<string, unknown> };

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

async function personalWorkspaceOf(): Promise<string> {
  const res = await api.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const personal = asArray(await res.json()).find(
    (workspace) => field(workspace, "kind") === "personal",
  );
  return requiredText(field(personal, "id"), "the personal workspace id");
}

async function fixture() {
  const workspaceId = await personalWorkspaceOf();
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Telemetry project ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = requiredText(field(await created.json(), "id"), "the project id");
  const agentRes = await api.post("/api/agents", {
    data: { name: `telemetry-agent-${randomUUID()}` },
  });
  expect(agentRes.status()).toBe(201);
  const agentId = requiredText(field(await agentRes.json(), "id"), "the agent id");
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const secret = requiredText(field(await keyRes.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return { projectId, secret };
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: `orrery-telemetry-e2e-${randomUUID()}`, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

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
  post: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
});

test("MCP agent loop reports cumulative totals and a v1 test_results block", async () => {
  const { projectId, secret } = await fixture();
  const client = await connect(secret);
  try {
    const created = await call(client, "create_issue", {
      projectId,
      title: `Telemetry loop ${randomUUID()}`,
    });
    expect(created.isError).toBe(false);
    const issueId = requiredText(field(asRecord(created.data.issue), "id"), "the issue id");

    // The new issue is offered as ready work before this agent claims it.
    const ready = await call(client, "ready_work", { projectId });
    expect(ready.isError).toBe(false);
    expect(asArray(field(ready.data, "issues")).map((issue) => field(issue, "id"))).toContain(
      issueId,
    );

    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    expect(field(claim.data.session, "inputTokens")).toBeNull();
    expect(field(claim.data.session, "outputTokens")).toBeNull();
    expect(field(claim.data.session, "costUsdMicros")).toBeNull();

    const renewed = await call(client, "renew_claim", {
      issueId,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(renewed.isError).toBe(false);
    expect(field(renewed.data.session, "inputTokens")).toBe(100);
    expect(field(renewed.data.session, "outputTokens")).toBe(20);
    expect(field(renewed.data.session, "costUsdMicros")).toBeNull();

    // A retry of the same totals is idempotent, not additive.
    const retried = await call(client, "renew_claim", {
      issueId,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(retried.isError).toBe(false);
    expect(field(retried.data.session, "inputTokens")).toBe(100);

    // Progress overwrites what it reports and preserves what it omits.
    const progressed = await call(client, "report_progress", {
      issueId,
      summary: "Tests run",
      inputTokens: 250,
      costUsdMicros: 750,
    });
    expect(progressed.isError).toBe(false);
    expect(field(progressed.data.session, "inputTokens")).toBe(250);
    expect(field(progressed.data.session, "outputTokens")).toBe(20);
    expect(field(progressed.data.session, "costUsdMicros")).toBe(750);

    // A v1 block is stored verbatim inside detail.
    const block = {
      version: 1,
      type: "test_results",
      passed: 3,
      failed: 0,
      skipped: 1,
      cases: [{ name: "adds", status: "passed" }],
    };
    const activity = await call(client, "log_session_activity", {
      issueId,
      kind: "status",
      summary: "Test results",
      detail: { source: "ci", block },
    });
    expect(activity.isError).toBe(false);
    expect(field(activity.data.activity, "detail")).toMatchObject({ source: "ci", block });

    // Arbitrary JSON without a block still passes through.
    const custom = await call(client, "log_session_activity", {
      issueId,
      kind: "thought",
      summary: "Custom",
      detail: { tool: "edit", nested: { step: 1 } },
    });
    expect(custom.isError).toBe(false);
    expect(field(custom.data.activity, "detail")).toEqual({ tool: "edit", nested: { step: 1 } });

    // Malformed v1 blocks and negative totals are refused by the tool's input schema.
    const badBlock = await call(client, "log_session_activity", {
      issueId,
      kind: "status",
      summary: "Bad block",
      detail: { block: { version: 1, type: "test_results", passed: -1, failed: 0 } },
    });
    expect(badBlock.isError).toBe(true);
    const negative = await call(client, "report_progress", {
      issueId,
      summary: "Bad totals",
      inputTokens: -1,
    });
    expect(negative.isError).toBe(true);

    const stopped = await call(client, "stop_session", {
      issueId,
      outcome: "completed",
      inputTokens: 400,
      costUsdMicros: 1200,
    });
    expect(stopped.isError).toBe(false);
    expect(field(stopped.data.session, "inputTokens")).toBe(400);
    expect(field(stopped.data.session, "outputTokens")).toBe(20);
    expect(field(stopped.data.session, "costUsdMicros")).toBe(1200);

    const readBack = await call(client, "get_work_session", { issueId });
    expect(readBack.isError).toBe(false);
    expect(field(readBack.data.session, "inputTokens")).toBe(400);
    expect(field(readBack.data.session, "outputTokens")).toBe(20);
    expect(field(readBack.data.session, "costUsdMicros")).toBe(1200);
  } finally {
    await client.close();
  }
});

test("REST reports cumulative totals and validates v1 blocks on the same session", async () => {
  const { projectId, secret } = await fixture();
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const created = await call(client, "create_issue", {
      projectId,
      title: `REST telemetry ${randomUUID()}`,
    });
    expect(created.isError).toBe(false);
    const issueId = requiredText(field(asRecord(created.data.issue), "id"), "the issue id");
    const runId = await newRun(client);
    const claim = await http.post(`/api/issues/${issueId}/work-sessions`, { runId });
    expect(claim.status).toBe(201);

    const renewed = await http.post(`/api/issues/${issueId}/work-sessions/renew`, {
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(renewed.status).toBe(200);
    expect(asRecord(await renewed.json())).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      costUsdMicros: null,
    });

    const progressed = await http.post(`/api/issues/${issueId}/work-sessions/progress`, {
      summary: "REST progress",
      costUsdMicros: 42,
    });
    expect(progressed.status).toBe(200);
    expect(asRecord(await progressed.json())).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      costUsdMicros: 42,
    });

    const block = { version: 1, type: "checklist", items: [{ label: "done", checked: true }] };
    const activity = await http.post(`/api/issues/${issueId}/work-sessions/activities`, {
      kind: "status",
      summary: "REST block",
      detail: { source: "ci", block },
    });
    expect(activity.status).toBe(201);
    expect(asRecord(await activity.json()).detail).toMatchObject({ source: "ci", block });

    const malformed = await http.post(`/api/issues/${issueId}/work-sessions/activities`, {
      kind: "status",
      summary: "Bad block",
      detail: { block: { version: 1, type: "checklist", items: [{ label: "done" }] } },
    });
    expect(malformed.status).toBe(400);
    expect(asRecord(await malformed.json())).toMatchObject({ code: "validation_failed" });

    const negative = await http.post(`/api/issues/${issueId}/work-sessions/renew`, {
      inputTokens: -1,
    });
    expect(negative.status).toBe(400);
    expect(asRecord(await negative.json())).toMatchObject({ code: "validation_failed" });

    const stopped = await http.post(`/api/issues/${issueId}/work-sessions/stop`, {
      outcome: "completed",
      inputTokens: 20,
    });
    expect(stopped.status).toBe(200);
    expect(asRecord(await stopped.json())).toMatchObject({
      inputTokens: 20,
      outputTokens: 3,
      costUsdMicros: 42,
    });
  } finally {
    await client.close();
  }
});
