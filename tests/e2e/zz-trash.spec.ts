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

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl: string = configuredUrl;

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const SMTP = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;
const TEAM = `Trash Team ${randomUUID()}`;
const MEMBER_EMAIL = `trash.member.${randomUUID()}@orrery.test`;
const MEMBER_PASSWORD = "trash-member-password";

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

async function invitationToken(): Promise<string | undefined> {
  const list = await api.get(`${mailpit}/api/v1/messages`);
  const messages = field(await list.json(), "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await api.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${TEAM}"`)) continue;
    if (!text.includes(MEMBER_EMAIL)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

// A shared project with a Contribute member, so restore's Manage-only gate can be proved
// over HTTP with a real second human rather than only at the service seam.
async function sharedContributeProject(): Promise<{
  member: APIRequestContext;
  project: { id: string; workspaceId: string };
}> {
  await api.put("/api/settings/smtp", { data: SMTP });
  const created = await api.post("/api/workspaces", { data: { name: TEAM } });
  expect(created.status()).toBe(201);
  const teamId = idOf(await created.json(), "workspace");
  const invited = await api.post(`/api/workspaces/${teamId}/invitations`, {
    data: { email: MEMBER_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect.poll(invitationToken, { timeout: 15_000 }).toBeTruthy();
  const token = await invitationToken();
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);
  await recordSecret(MEMBER_PASSWORD);
  const registration = await request.newContext({ baseURL: baseUrl });
  try {
    const accepted = await registration.post("/api/workspace-invitations/registration", {
      data: { token, password: MEMBER_PASSWORD },
    });
    expect(accepted.status()).toBe(200);
  } finally {
    await registration.dispose();
  }
  const member = await request.newContext({ baseURL: baseUrl });
  const login = await member.post("/api/auth/login", {
    data: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const projectRes = await api.post(`/api/workspaces/${teamId}/projects`, {
    data: { name: "Shared Trash Project", key: "TRMT" },
  });
  expect(projectRes.status()).toBe(201);
  const projectId = idOf(await projectRes.json(), "project");
  const grant = await api.patch(`/api/projects/${projectId}/access`, {
    data: { email: MEMBER_EMAIL, level: "contribute" },
  });
  expect(grant.status()).toBe(200);
  return { member, project: { id: projectId, workspaceId: teamId } };
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

test("agents get 403 on delete, no trash tool, and trashed issues vanish from ready work", async () => {
  const project = await createProject("TRSM");
  const secret = await agentKey(project.id, project.workspaceId);
  const blockerId = await createIssue(project.id, "Agent-protected issue");
  const dependentId = await createIssue(project.id, "Dependent issue");

  const agentApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });
  try {
    const removed = await agentApi.delete(`/api/issues/${blockerId}`);
    expect(removed.status()).toBe(403);
    expect(await removed.json()).toMatchObject({
      code: "agents_cannot_delete_issues",
      status: 403,
    });
    const trash = await agentApi.get(`/api/projects/${project.id}/trash`);
    expect(trash.status()).toBe(403);
    const restore = await agentApi.post(`/api/issues/${blockerId}/restore`);
    expect(restore.status()).toBe(403);
  } finally {
    await agentApi.dispose();
  }

  const depends = await api.post(`/api/issues/${dependentId}/blocked-by`, {
    data: { blockedByIssueId: blockerId },
  });
  expect(depends.status()).toBe(201);

  const client = await connect(secret);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => /delete_issue|restore_issue|trash/.test(name))).toBe(false);

    // The active issue is visible before the delete and hidden afterwards over MCP.
    const visible = await call(client, "get_issue", { issueId: blockerId });
    expect(visible.isError).toBe(false);
    expect(field(visible.data.issue, "id")).toBe(blockerId);
    const blockedBefore = await call(client, "list_blocked_by", { issueId: dependentId });
    expect(asArray(blockedBefore.data.issues).map((issue) => field(issue, "id"))).toContain(
      blockerId,
    );
    const readyBefore = await call(client, "ready_work", { projectId: project.id });
    expect(asArray(readyBefore.data.issues).map((issue) => field(issue, "id"))).not.toContain(
      dependentId,
    );

    const removed = await api.delete(`/api/issues/${blockerId}`);
    expect(removed.status()).toBe(204);

    const hidden = await call(client, "get_issue", { issueId: blockerId });
    expect(hidden.isError).toBe(true);
    expect(hidden.data).toMatchObject({ code: "issue_not_found" });
    const blockedAfter = await call(client, "list_blocked_by", { issueId: dependentId });
    expect(asArray(blockedAfter.data.issues).map((issue) => field(issue, "id"))).not.toContain(
      blockerId,
    );
    const readyAfter = await call(client, "ready_work", { projectId: project.id });
    const readyIds = asArray(readyAfter.data.issues).map((issue) => field(issue, "id"));
    expect(readyIds).toContain(dependentId);
    expect(readyIds).not.toContain(blockerId);
  } finally {
    await client.close();
  }
});

test("a live work session fences delete, and a non-Manager human cannot restore", async () => {
  const { member, project } = await sharedContributeProject();
  const secret = await agentKey(project.id, project.workspaceId);
  const claimedId = await createIssue(project.id, "Claimed issue");

  const claimClient = await connect(secret);
  try {
    const run = await call(claimClient, "orrery_run_checkin", {
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: randomUUID() },
    });
    const runId = requiredText(field(run.data, "runId"), "the run id");
    const claimed = await call(claimClient, "claim_issue", { issueId: claimedId, runId });
    expect(claimed.isError).toBe(false);
    const conflict = await api.delete(`/api/issues/${claimedId}`);
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "issue_active_session_exists",
      status: 409,
    });
  } finally {
    await claimClient.close();
  }

  // A Contribute member of a shared workspace may delete but may not restore.
  const memberIssue = await createIssue(project.id, "Member trash issue");
  try {
    const removed = await api.delete(`/api/issues/${memberIssue}`);
    expect(removed.status()).toBe(204);
    const refused = await member.post(`/api/issues/${memberIssue}/restore`);
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "insufficient_project_access",
      status: 403,
    });
    const hiddenTrash = await member.get(`/api/projects/${project.id}/trash`);
    expect(hiddenTrash.status()).toBe(403);
  } finally {
    await member.dispose();
  }
});
