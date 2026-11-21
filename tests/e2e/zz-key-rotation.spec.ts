import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const OWNER_EMAIL = `key-rotation-${randomUUID()}@orrery.test`;
const INITIAL_PASSWORD = "key-rotation-initial-password";
const RESET_PASSWORD = "key-rotation-reset-password";
const RESET_SUBJECT = "Reset your Orrery password";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "the personal workspace");
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
      validity: "7",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  const secret = requiredText(field(body, "secret"), "the key secret");
  await recordSecret(secret);
  return { id: idOf(field(body, "key"), "key"), secret };
}

async function rotateKey(
  client: APIRequestContext,
  keyId: string,
): Promise<{ id: string; secret: string; body: unknown }> {
  const res = await client.post(`/api/agents/keys/${encodeURIComponent(keyId)}/rotate`, {
    data: {},
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  const secret = requiredText(field(body, "secret"), "the replacement secret");
  await recordSecret(secret);
  return { id: idOf(field(body, "key"), "replacement key"), secret, body };
}

const bearerGet = (path: string, secret: string) =>
  fetch(new URL(path, baseUrl), { headers: { Authorization: `Bearer ${secret}` } });

async function mcpCanListProjects(secret: string, workspaceId: string): Promise<boolean> {
  const client = new Client({ name: "orrery-e2e-rotation", version: "0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
        authProvider: { token: async () => secret },
      }),
    );
    const result = await client.callTool({
      name: "list_projects",
      arguments: { workspaceId },
    });
    return result.isError !== true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function caughtInvitationToken(
  client: APIRequestContext,
  to: string,
): Promise<string | undefined> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const messages: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const text = field(caught, "Text");
    if (typeof text !== "string") continue;
    const toAddresses = field(caught, "To");
    const addresses = Array.isArray(toAddresses)
      ? toAddresses.flatMap((entry: unknown) => {
          const address = field(entry, "Address");
          return typeof address === "string" ? [address] : [];
        })
      : [];
    if (!addresses.includes(to)) continue;
    const token = /\/register\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

async function resetToken(client: APIRequestContext, to: string): Promise<string> {
  await expect.poll(async () => caughtResetToken(client, to), { timeout: 15_000 }).toBeTruthy();
  const token = await caughtResetToken(client, to);
  if (token === undefined) throw new Error("the catcher never received the reset email");
  return token;
}

async function caughtResetToken(
  client: APIRequestContext,
  to: string,
): Promise<string | undefined> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const messages: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== RESET_SUBJECT) continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const text = field(caught, "Text");
    if (typeof text !== "string") continue;
    const toAddresses = field(caught, "To");
    const addresses = Array.isArray(toAddresses)
      ? toAddresses.flatMap((entry: unknown) => {
          const address = field(entry, "Address");
          return typeof address === "string" ? [address] : [];
        })
      : [];
    if (!addresses.includes(to)) continue;
    return /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  }
  return undefined;
}

let admin: APIRequestContext;
let owner: APIRequestContext;

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);

  for (const secret of [INITIAL_PASSWORD, RESET_PASSWORD]) await recordSecret(secret);
  const invited = await admin.post("/api/invitations/installation", {
    data: { email: OWNER_EMAIL },
  });
  expect(invited.status()).toBe(201);
  const token = await caughtInvitationToken(admin, OWNER_EMAIL);
  if (token === undefined) throw new Error("the invitation never reached the catcher");
  await recordSecret(token);
  const registered = await admin.post("/api/invitations/installation/registration", {
    data: { token, password: INITIAL_PASSWORD },
  });
  expect(registered.status()).toBe(200);
  expect(await registered.json()).toMatchObject({ email: OWNER_EMAIL, emailVerified: true });

  owner = await request.newContext({ baseURL: baseUrl });
  const ownerLogin = await owner.post("/api/auth/login", {
    data: { email: OWNER_EMAIL, password: INITIAL_PASSWORD },
  });
  expect(ownerLogin.status()).toBe(200);
});

test.afterAll(async () => {
  await admin?.dispose();
  await owner?.dispose();
});

test("overlap, switch the client, revoke the old key, then reset the password", async () => {
  const workspaceId = await personalWorkspaceOf(owner);
  const created = await owner.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Rotation project ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentId = await createAgent(owner, `rotation-bot-${randomUUID()}`);
  const source = await issueKey(owner, agentId, workspaceId, projectId);

  const replacement = await rotateKey(owner, source.id);
  const key: unknown = field(replacement.body, "key");
  expect(replacement.id).not.toBe(source.id);
  expect(replacement.secret).not.toBe(source.secret);
  expect(replacement.secret).toMatch(/^orr_ak_/);
  expect(key).toMatchObject({
    agentId,
    workspaceId,
    replacesKeyId: source.id,
    validity: "7",
  });
  expect(JSON.stringify(replacement.body)).not.toContain(source.secret);
  const listed = await owner.get("/api/agents/keys");
  expect(listed.status()).toBe(200);
  expect(JSON.stringify(await listed.json())).not.toContain(source.secret);

  for (const secret of [source.secret, replacement.secret]) {
    const me = await bearerGet("/api/agents/me", secret);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ agentId, workspaceId });
    expect(await mcpCanListProjects(secret, workspaceId)).toBe(true);
  }

  const issue = await fetch(new URL(`/api/projects/${projectId}/issues`, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${replacement.secret}`,
    },
    body: JSON.stringify({ title: "Filed after rotation" }),
  });
  expect(issue.status).toBe(201);
  expect(field(await issue.json(), "createdBy")).toMatchObject({ agentId });

  const revoked = await owner.delete(`/api/agents/keys/${source.id}`);
  expect(revoked.status()).toBe(204);
  const oldRefused = await bearerGet("/api/agents/me", source.secret);
  expect(oldRefused.status).toBe(401);
  expect(await oldRefused.json()).toMatchObject({ code: "key_revoked" });
  expect(await mcpCanListProjects(source.secret, workspaceId)).toBe(false);
  expect((await bearerGet("/api/agents/me", replacement.secret)).status).toBe(200);
  expect(await mcpCanListProjects(replacement.secret, workspaceId)).toBe(true);

  const sessionBefore = await owner.get("/api/auth/session");
  expect(sessionBefore.status()).toBe(200);
  const asked = await owner.post("/api/auth/password-reset/request", {
    data: { email: OWNER_EMAIL },
  });
  expect(asked.status()).toBe(200);
  const token = await resetToken(owner, OWNER_EMAIL);
  await recordSecret(token);
  const confirmed = await owner.post("/api/auth/password-reset/confirm", {
    data: { token, password: RESET_PASSWORD },
  });
  expect(confirmed.status()).toBe(200);
  expect((await owner.get("/api/auth/session")).status()).toBe(401);

  const afterReset = await bearerGet("/api/agents/me", replacement.secret);
  expect(afterReset.status).toBe(200);
  expect(await afterReset.json()).toMatchObject({ agentId, keyId: replacement.id });
  expect((await bearerGet("/api/agents/me", source.secret)).status).toBe(401);
  expect(await mcpCanListProjects(replacement.secret, workspaceId)).toBe(true);
  expect(await mcpCanListProjects(source.secret, workspaceId)).toBe(false);
  const relogin = await request.newContext({ baseURL: baseUrl });
  try {
    const res = await relogin.post("/api/auth/login", {
      data: { email: OWNER_EMAIL, password: RESET_PASSWORD },
    });
    expect(res.status()).toBe(200);
  } finally {
    await relogin.dispose();
  }
});
