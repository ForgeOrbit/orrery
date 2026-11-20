// Agent project work through MCP (issue #33), black-box against a running Orrery. A real
// MCP protocol client uses a workspace-scoped API key to run the issue/knowledge cycle,
// then proves Read keys, out-of-scope keys, and revoked keys are refused. The same
// operations are read back over REST, and no membership or administration tool is exposed.
// Nothing here imports server code.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_EMAIL = "workspace.existing@orrery.test";
const MEMBER_PASSWORD = "existing-workspace-password";

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

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name } });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "agent");
}

async function issueKey(
  client: APIRequestContext,
  agentId: string,
  workspaceId: string,
  grants: { projectId: string; level: string }[],
): Promise<{ id: string; secret: string }> {
  const res = await client.post("/api/agents/keys", {
    data: { agentId, workspaceId, validity: "90", projects: grants },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  const secret = requiredText(field(body, "secret"), "the key secret");
  await recordSecret(secret);
  return { id: idOf(field(body, "key"), "key"), secret };
}

async function caughtWorkspaceToken(workspaceName: string): Promise<string | undefined> {
  const list = await api.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const messages: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await api.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const toAddresses = field(caught, "To");
    const addresses = Array.isArray(toAddresses)
      ? toAddresses.flatMap((entry) => {
          const address = field(entry, "Address");
          return typeof address === "string" ? [address] : [];
        })
      : [];
    if (!addresses.includes(MEMBER_EMAIL)) continue;
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

type CallResult = { isError: boolean; data: Record<string, unknown> };

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: "orrery-e2e-mcp", version: "0" });
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
  const data = asRecord(result.structuredContent);
  return { isError: result.isError === true, data };
}

let api: APIRequestContext;
let memberApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  memberApi = await request.newContext({ baseURL: baseUrl });
  const memberLogin = await memberApi.post("/api/auth/login", {
    data: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
  });
  expect(memberLogin.status()).toBe(200);
});
test.afterAll(async () => {
  await api?.dispose();
  await memberApi?.dispose();
});

test("exposes project work only: no membership, access, or administration tools", async () => {
  const agentId = await createAgent(api, `mcp-tools-bot-${randomUUID()}`);
  const workspaceId = await personalWorkspaceOf(api);
  const key = await issueKey(api, agentId, workspaceId, []);
  const client = await connect(key.secret);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_projects",
        "get_project",
        "list_issues",
        "get_issue",
        "create_issue",
        "update_issue",
        "list_comments",
        "create_comment",
        "list_activity",
        "list_knowledge",
        "get_knowledge",
        "create_knowledge",
        "update_knowledge",
      ]),
    );
    for (const name of names) {
      expect(name).not.toMatch(/member|invit|workspace|access|setting|key|admin|grant/);
    }
  } finally {
    await client.close();
  }
});

test("runs the Contribute issue and knowledge cycle over MCP and reads it back over REST", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP project ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentName = `mcp-writer-${randomUUID()}`;
  const agentId = await createAgent(api, agentName);
  const key = await issueKey(api, agentId, workspaceId, [{ projectId, level: "contribute" }]);
  const client = await connect(key.secret);
  try {
    const issueResult = await call(client, "create_issue", {
      projectId,
      title: "An MCP issue",
      body: "Created by an agent key.",
    });
    expect(issueResult.isError).toBe(false);
    const issue = asRecord(issueResult.data.issue);
    expect(issue).toMatchObject({ status: "open", number: 1 });
    expect(field(issue, "createdBy")).toMatchObject({
      agentId,
      displayName: agentName,
    });
    const issueId = requiredText(field(issue, "id"), "the issue id");

    const closed = await call(client, "update_issue", { issueId, status: "closed" });
    expect(closed.isError).toBe(false);
    expect(field(closed.data.issue, "status")).toBe("closed");
    expect(field(field(closed.data.issue, "updatedBy"), "agentId")).toBe(agentId);

    const comment = await call(client, "create_comment", { issueId, body: "Agent comment" });
    expect(comment.isError).toBe(false);
    expect(field(field(comment.data.comment, "author"), "agentId")).toBe(agentId);

    const entry = await call(client, "create_knowledge", { projectId, title: "Agent note" });
    expect(entry.isError).toBe(false);
    const entryId = requiredText(field(entry.data.entry, "id"), "the knowledge id");
    const edited = await call(client, "update_knowledge", { entryId, body: "More detail" });
    expect(edited.isError).toBe(false);
    expect(field(field(edited.data.entry, "updatedBy"), "agentId")).toBe(agentId);

    const activity = await call(client, "list_activity", { projectId });
    expect(activity.isError).toBe(false);
    const events = asArray(field(activity.data, "activity"));
    const agentEvents = events.filter((event) => field(event, "type") !== "project_created");
    expect(agentEvents.length).toBeGreaterThan(0);
    for (const event of agentEvents) {
      expect(field(field(event, "actor"), "agentId")).toBe(agentId);
      expect(field(field(event, "actor"), "humanId")).toBeFalsy();
    }

    // The same resources read over REST carry the same agent actor: REST and MCP agree.
    const restIssue = await api.get(`/api/issues/${issueId}`);
    expect(restIssue.status()).toBe(200);
    expect(field(await restIssue.json(), "createdBy")).toMatchObject({ agentId });
  } finally {
    await client.close();
  }
});

test("a Read key inspects but cannot change work, matching a human Read REST denial", async () => {
  const workspaceName = `MCP read team ${randomUUID()}`;
  const workspaceRes = await api.post("/api/workspaces", { data: { name: workspaceName } });
  expect(workspaceRes.status()).toBe(201);
  const workspaceId = idOf(await workspaceRes.json(), "workspace");
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP read project ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const writer = await createAgent(api, `mcp-seed-${randomUUID()}`);
  const writerKey = await issueKey(api, writer, workspaceId, [{ projectId, level: "contribute" }]);
  const writerClient = await connect(writerKey.secret);
  let issueId = "";
  let entryId = "";
  try {
    const seeded = await call(writerClient, "create_issue", { projectId, title: "Seed issue" });
    issueId = requiredText(field(seeded.data.issue, "id"), "the issue id");
    const seededEntry = await call(writerClient, "create_knowledge", {
      projectId,
      title: "Seed note",
    });
    entryId = requiredText(field(seededEntry.data.entry, "id"), "the knowledge id");
  } finally {
    await writerClient.close();
  }

  const reader = await createAgent(api, `mcp-reader-${randomUUID()}`);
  const readerKey = await issueKey(api, reader, workspaceId, [{ projectId, level: "read" }]);
  const client = await connect(readerKey.secret);
  try {
    expect((await call(client, "list_issues", { projectId })).isError).toBe(false);
    expect((await call(client, "get_issue", { issueId })).isError).toBe(false);
    expect((await call(client, "list_comments", { issueId })).isError).toBe(false);
    expect((await call(client, "list_knowledge", { projectId })).isError).toBe(false);
    expect((await call(client, "list_activity", { projectId })).isError).toBe(false);

    const denials = await Promise.all([
      call(client, "create_issue", { projectId, title: "No" }),
      call(client, "update_issue", { issueId, status: "closed" }),
      call(client, "create_comment", { issueId, body: "No" }),
      call(client, "create_knowledge", { projectId, title: "No" }),
      call(client, "update_knowledge", { entryId, body: "No" }),
    ]);
    for (const denial of denials) {
      expect(denial.isError).toBe(true);
      expect(field(denial.data, "code")).toBe("insufficient_project_access");
    }
  } finally {
    await client.close();
  }

  // The equivalent human REST write denial has the same stable code: invite a member
  // with Read on this project and try the same close directly over REST.
  const invited = await api.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: MEMBER_EMAIL, projectGrants: [{ projectId, level: "read" }] },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtWorkspaceToken(workspaceName), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtWorkspaceToken(workspaceName);
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);
  const accepted = await memberApi.post("/api/workspace-invitations/acceptance", {
    data: { token },
  });
  expect(accepted.status()).toBe(200);
  const humanDenied = await memberApi.patch(`/api/issues/${issueId}`, {
    data: { status: "closed" },
  });
  expect(humanDenied.status()).toBe(403);
  expect(await humanDenied.json()).toMatchObject({
    status: 403,
    code: "insufficient_project_access",
  });
  // A bearer key is not accepted on human REST routes at all. Use a fresh context so no
  // signed-in cookie can accidentally authorize the request.
  const bearerOnly = await request.newContext({ baseURL: baseUrl });
  try {
    const bearerWrite = await bearerOnly.patch(`/api/issues/${issueId}`, {
      data: { status: "closed" },
      headers: { Authorization: `Bearer ${readerKey.secret}` },
    });
    expect(bearerWrite.status()).toBe(401);
  } finally {
    await bearerOnly.dispose();
  }
});

test("refuses out-of-scope projects and a revoked key over MCP", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const scoped = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP scoped ${randomUUID()}` },
  });
  expect(scoped.status()).toBe(201);
  const scopedId = idOf(await scoped.json(), "project");
  const outside = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP outside ${randomUUID()}` },
  });
  expect(outside.status()).toBe(201);
  const outsideId = idOf(await outside.json(), "project");

  const agentId = await createAgent(api, `mcp-scoped-${randomUUID()}`);
  const key = await issueKey(api, agentId, workspaceId, [
    { projectId: scopedId, level: "contribute" },
  ]);
  const client = await connect(key.secret);
  try {
    const outOfScope = await call(client, "create_issue", { projectId: outsideId, title: "No" });
    expect(outOfScope.isError).toBe(true);
    expect(field(outOfScope.data, "code")).toBe("project_not_found");
  } finally {
    await client.close();
  }

  const revoked = await api.delete(`/api/agents/keys/${key.id}`);
  expect(revoked.status()).toBe(204);
  const revokedClient = await connect(key.secret);
  try {
    const denied = await call(revokedClient, "list_projects", { workspaceId });
    expect(denied.isError).toBe(true);
    expect(field(denied.data, "code")).toBe("key_revoked");
  } finally {
    await revokedClient.close();
  }
});
