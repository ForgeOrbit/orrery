// Workspace-scoped agent API keys (issue #30), black-box against a running Orrery:
// register an agent, issue a key, authenticate a REST request as that agent, and prove
// that cross-workspace, revoked, and owner-revoked keys are refused. Nothing here imports
// server code; everything goes through HTTP and the Mailpit catcher.
//
// Runs after the other specs (alphabetical file order, one worker), which bootstrap the
// administrator and create the existing verified account used as the key's owner.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_EMAIL = "workspace.existing@orrery.test";
const MEMBER_PASSWORD = "existing-workspace-password";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

function idOf(value: unknown, what: string): string {
  return requiredText(field(value, "id"), `the ${what} id`);
}

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function invitedToken(client: APIRequestContext, to: string, workspaceName: string) {
  await expect
    .poll(async () => caughtWorkspaceToken(client, to, workspaceName), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtWorkspaceToken(client, to, workspaceName);
  if (token === undefined) throw new Error("the catcher never received the invitation");
  return token;
}

async function caughtWorkspaceToken(
  client: APIRequestContext,
  to: string,
  workspaceName: string,
): Promise<string | undefined> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const messages: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
    const toAddresses = field(caught, "To");
    const addresses = Array.isArray(toAddresses)
      ? toAddresses.flatMap((entry) => {
          const address = field(entry, "Address");
          return typeof address === "string" ? [address] : [];
        })
      : [];
    if (!addresses.includes(to)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
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
  projectId: string,
): Promise<{ id: string; secret: string }> {
  const res = await client.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "read" }],
    },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  const secret = requiredText(field(body, "secret"), "the key secret");
  await recordSecret(secret);
  return { id: idOf(field(body, "key"), "key"), secret };
}

// A separate request context whose cookie jar belongs to the agent's human, so the
// bearer request is never helped by a signed-in browser session.
async function bearerGet(client: APIRequestContext, path: string, secret: string) {
  return client.get(path, { headers: { Authorization: `Bearer ${secret}` } });
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

test("issues a key and resolves the agent identity from a bearer REST request", async () => {
  const personal = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${personal}/projects`, {
    data: { name: `Agent project ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentId = await createAgent(api, `e2e-bot-${randomUUID()}`);
  const issued = await issueKey(api, agentId, personal, projectId);

  const anonymous = await api.get("/api/agents/me");
  expect(anonymous.status()).toBe(401);

  const me = await bearerGet(api, "/api/agents/me", issued.secret);
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({
    agentId,
    keyId: issued.id,
    workspaceId: personal,
    projects: [{ projectId, level: "read" }],
  });

  // The secret is shown once: no later listing can recover it.
  const listed = await api.get("/api/agents/keys");
  expect(listed.status()).toBe(200);
  expect(JSON.stringify(await listed.json())).not.toContain(issued.secret);
});

test("refuses a key used in another workspace or on a project outside its scope", async () => {
  const personal = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${personal}/projects`, {
    data: { name: `Scoped project ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentId = await createAgent(api, `scoped-bot-${randomUUID()}`);
  const issued = await issueKey(api, agentId, personal, projectId);

  const other = await api.post("/api/workspaces", { data: { name: `Other ${randomUUID()}` } });
  expect(other.status()).toBe(201);
  const otherId = idOf(await other.json(), "workspace");
  const otherProject = await api.post(`/api/workspaces/${otherId}/projects`, {
    data: { name: "Outside" },
  });
  expect(otherProject.status()).toBe(201);
  const outsideId = idOf(await otherProject.json(), "project");

  const cross = await bearerGet(api, `/api/agents/me?workspaceId=${otherId}`, issued.secret);
  expect(cross.status()).toBe(403);
  expect(await cross.json()).toMatchObject({ status: 403, code: "key_out_of_scope" });
  const out = await bearerGet(api, `/api/agents/me?projectId=${outsideId}`, issued.secret);
  expect(out.status()).toBe(403);
  expect(await out.json()).toMatchObject({ status: 403, code: "insufficient_agent_access" });
});

test("a workspace owner revokes another human's key without seeing its secret, and leaves their keys elsewhere alone", async () => {
  const name = `Agent Team ${randomUUID()}`;
  const created = await api.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspaceId = idOf(await created.json(), "workspace");
  const projectResponse = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Agent team project" },
  });
  expect(projectResponse.status()).toBe(201);
  const projectId = idOf(await projectResponse.json(), "project");

  const invitation = await api.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: MEMBER_EMAIL, projectGrants: [{ projectId, level: "read" }] },
  });
  expect(invitation.status()).toBe(201);
  const token = await invitedToken(api, MEMBER_EMAIL, name);
  await recordSecret(token);
  const accepted = await memberApi.post("/api/workspace-invitations/acceptance", {
    data: { token },
  });
  expect(accepted.status()).toBe(200);

  // The member owns an agent with a key in this workspace and another in their personal
  // workspace. The second key is the one the owner must not be able to affect.
  const memberAgent = await createAgent(memberApi, `member-bot-${randomUUID()}`);
  const teamKey = await issueKey(memberApi, memberAgent, workspaceId, projectId);
  const personal = await personalWorkspaceOf(memberApi);
  const ownProject = await memberApi.post(`/api/workspaces/${personal}/projects`, {
    data: { name: "Private agent project" },
  });
  expect(ownProject.status()).toBe(201);
  const ownKey = await issueKey(
    memberApi,
    memberAgent,
    personal,
    idOf(await ownProject.json(), "project"),
  );

  // The owner's view lists the team key but carries no secret.
  const ownerList = await api.get(`/api/workspaces/${workspaceId}/agent-keys`);
  expect(ownerList.status()).toBe(200);
  const ownerBody = await ownerList.json();
  expect(JSON.stringify(ownerBody)).toContain(teamKey.id);
  expect(JSON.stringify(ownerBody)).not.toContain(teamKey.secret);

  const revoke = await api.delete(`/api/workspaces/${workspaceId}/agent-keys/${teamKey.id}`);
  expect(revoke.status()).toBe(204);
  expect((await bearerGet(api, "/api/agents/me", teamKey.secret)).status()).toBe(401);
  // The same key still works in the member's own workspace; the owner's action did not
  // reach it, and the owner cannot name it through the team's revoke route.
  expect((await bearerGet(memberApi, "/api/agents/me", ownKey.secret)).status()).toBe(200);
  const elsewhere = await api.delete(`/api/workspaces/${workspaceId}/agent-keys/${ownKey.id}`);
  expect(elsewhere.status()).toBe(404);
});
