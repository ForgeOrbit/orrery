// #98 black-box proof: human-only issue soft-delete, Project manager restore, and the
// agent-facing denials over REST and MCP against a running Orrery. The 30-day scrub
// boundary itself is proved at the real-Postgres service seam in trash.test.ts, because
// an e2e client cannot move the database clock.
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
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

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

async function createProject(key: string): Promise<{ id: string; workspaceId: string }> {
  const workspaces = await api.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const personal = asArray(await workspaces.json()).find((w) => field(w, "kind") === "personal");
  const workspaceId = idOf(personal, "personal workspace");
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Trash ${key}`, key },
  });
  expect(created.status()).toBe(201);
  return { id: idOf(await created.json(), "project"), workspaceId };
}

async function createIssue(projectId: string, title: string): Promise<string> {
  const created = await api.post(`/api/projects/${projectId}/issues`, { data: { title } });
  expect(created.status()).toBe(201);
  return idOf(await created.json(), "issue");
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: "orrery-e2e-trash", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: asRecord(result.structuredContent) };
}

async function agentKey(projectId: string, workspaceId: string): Promise<string> {
  const agentName = `trash-agent-${randomUUID()}`;
  const agentRes = await api.post("/api/agents", { data: { name: agentName } });
  expect(agentRes.status()).toBe(201);
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId: idOf(await agentRes.json(), "agent"),
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "manage" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const secret = requiredText(field(await keyRes.json(), "secret"), "the agent key secret");
  await recordSecret(secret);
  return secret;
}

test("REST soft-deletes into trash, then restores with the audit events", async () => {
  const project = await createProject("TRSH");
  const issueId = await createIssue(project.id, "Mistaken issue");

  const removed = await api.delete(`/api/issues/${issueId}`);
  expect(removed.status()).toBe(204);

  const hidden = await api.get(`/api/issues/${issueId}`);
  expect(hidden.status()).toBe(404);
  expect(await hidden.json()).toMatchObject({ code: "issue_not_found", status: 404 });

  const issues = await api.get(`/api/projects/${project.id}/issues`);
  expect(asArray(await issues.json()).map((issue) => field(issue, "id"))).not.toContain(issueId);

  const trash = await api.get(`/api/projects/${project.id}/trash`);
  expect(trash.status()).toBe(200);
  expect(asArray(await trash.json()).map((issue) => field(issue, "id"))).toContain(issueId);

  const again = await api.delete(`/api/issues/${issueId}`);
  expect(again.status()).toBe(404);

  const restored = await api.post(`/api/issues/${issueId}/restore`);
  expect(restored.status()).toBe(200);
  expect(await restored.json()).toMatchObject({ id: issueId });

  const visible = await api.get(`/api/issues/${issueId}`);
  expect(visible.status()).toBe(200);
  const activity = await api.get(`/api/projects/${project.id}/activity`);
  const types = asArray(await activity.json()).map((event) => field(event, "type"));
  expect(types).toContain("issue_deleted");
  expect(types).toContain("issue_restored");
});

test("agents get 403 on delete and no trash tool, and a claimed issue is 409", async () => {
  const project = await createProject("TRSM");
  const secret = await agentKey(project.id, project.workspaceId);
  const issueId = await createIssue(project.id, "Agent-protected issue");

  const agentApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });
  try {
    const removed = await agentApi.delete(`/api/issues/${issueId}`);
    expect(removed.status()).toBe(403);
    expect(await removed.json()).toMatchObject({
      code: "agents_cannot_delete_issues",
      status: 403,
    });
    const trash = await agentApi.get(`/api/projects/${project.id}/trash`);
    expect(trash.status()).toBe(403);
    const restore = await agentApi.post(`/api/issues/${issueId}/restore`);
    expect(restore.status()).toBe(403);
  } finally {
    await agentApi.dispose();
  }

  const client = await connect(secret);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => /delete_issue|restore_issue|trash/.test(name))).toBe(false);
    const hidden = await call(client, "get_issue", { issueId });
    expect(hidden.isError).toBe(true);
  } finally {
    await client.close();
  }

  // A live work session fences the human delete with a 409 until it ends.
  const claimClient = await connect(secret);
  try {
    const run = await call(claimClient, "orrery_run_checkin", {
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: randomUUID() },
    });
    const runId = requiredText(field(run.data, "runId"), "the run id");
    const claimed = await call(claimClient, "claim_issue", { issueId, runId });
    expect(claimed.isError).toBe(false);
    const conflict = await api.delete(`/api/issues/${issueId}`);
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "issue_active_session_exists",
      status: 409,
    });
  } finally {
    await claimClient.close();
  }
});
