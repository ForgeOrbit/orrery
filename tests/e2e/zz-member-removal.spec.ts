// Member removal and voluntary leave (issue #37), black-box against a running Orrery.
// A real signed-in member and an agent key prove that removal revokes the key immediately,
// that re-invitation starts with no grants and cannot revive the old key, that voluntary
// leave works while the last owner is blocked, and that distinct audit events surface.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_PASSWORD = "removal-member-password";
const SMTP_SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none" as const,
  username: null,
  password: null,
  from: "orrery@orrery.test",
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// Mailpit keeps old messages, so a re-invitation is the matching token whose preview is
// still live rather than whichever message happens to be first in the inbox.
async function matchingTokens(
  client: APIRequestContext,
  to: string,
  workspaceName: string,
): Promise<string[]> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const found: string[] = [];
  for (const message of asArray(field(body, "messages"))) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
    const addresses = asArray(field(caught, "To")).flatMap((entry) => {
      const address = field(entry, "Address");
      return typeof address === "string" ? [address] : [];
    });
    if (!addresses.includes(to)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) found.push(token);
  }
  return found;
}

async function liveInvitationToken(
  client: APIRequestContext,
  to: string,
  workspaceName: string,
): Promise<string> {
  let live: string | undefined;
  await expect
    .poll(
      async () => {
        for (const token of await matchingTokens(client, to, workspaceName)) {
          if (
            (await client.get(`/api/workspace-invitations/preview?token=${token}`)).status() === 200
          ) {
            live = token;
            return true;
          }
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return requiredText(live, "a live invitation token");
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
  projects: { projectId: string; level: string }[],
): Promise<string> {
  const res = await client.post("/api/agents/keys", {
    data: { agentId, workspaceId, validity: "90", projects },
  });
  expect(res.status()).toBe(201);
  const secret = requiredText(field(await res.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

const bearerGet = (client: APIRequestContext, path: string, secret: string) =>
  client.get(path, { headers: { Authorization: `Bearer ${secret}` } });

let admin: APIRequestContext;
let member: APIRequestContext;
let memberEmail: string;

async function signInMember() {
  const login = await member.post("/api/auth/login", {
    data: { email: memberEmail, password: MEMBER_PASSWORD },
  });
  expect(login.status()).toBe(200);
}

// Each test gets its own mailbox and verified account, so a departure in one test can
// never affect the membership or credentials used in another.
async function registerMember(input: {
  name: string;
  workspaceId: string;
  projectId: string;
  level: string;
}) {
  memberEmail = `removal.member.${randomUUID()}@orrery.test`;
  const invitation = await admin.post(`/api/workspaces/${input.workspaceId}/invitations`, {
    data: {
      email: memberEmail,
      projectGrants: [{ projectId: input.projectId, level: input.level }],
    },
  });
  expect(invitation.status()).toBe(201);
  const token = await liveInvitationToken(admin, memberEmail, input.name);
  await recordSecret(token);
  const registration = await member.post("/api/workspace-invitations/registration", {
    data: { token, password: MEMBER_PASSWORD },
  });
  expect(registration.status()).toBe(200);
  await signInMember();
}

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  expect((await admin.put("/api/settings/smtp", { data: SMTP_SETTINGS })).status()).toBe(200);
  member = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await admin?.dispose();
  await member?.dispose();
});

test("removal revokes the member's key and re-invitation cannot revive it or keep old grants", async () => {
  const name = `Removal Team ${randomUUID()}`;
  const created = await admin.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspaceId = idOf(await created.json(), "workspace");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Removal project" },
  });
  expect(project.status()).toBe(201);
  const projectId = idOf(await project.json(), "project");
  await registerMember({ name, workspaceId, projectId, level: "contribute" });

  const agentId = await createAgent(member, `removal-bot-${randomUUID()}`);
  const key = await issueKey(member, agentId, workspaceId, [{ projectId, level: "contribute" }]);
  const live = await bearerGet(admin, "/api/agents/me", key);
  expect(live.status()).toBe(200);
  expect(await live.json()).toMatchObject({ agentId, workspaceId });

  const directory = await admin.get(`/api/workspaces/${workspaceId}/members`);
  expect(directory.status()).toBe(200);
  const target = asArray(await directory.json()).find((row) => field(row, "email") === memberEmail);
  const humanId = requiredText(field(target, "humanId"), "the member id");

  const removed = await admin.delete(`/api/workspaces/${workspaceId}/members/${humanId}`);
  expect(removed.status()).toBe(204);
  const refused = await bearerGet(admin, "/api/agents/me", key);
  expect(refused.status()).toBe(401);
  expect(await refused.json()).toMatchObject({ status: 401, code: "key_revoked" });

  // Re-invite with no project grants: the old key stays dead and the new key starts empty.
  const reInvite = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: memberEmail, projectGrants: [] },
  });
  expect(reInvite.status()).toBe(201);
  const freshToken = await liveInvitationToken(admin, memberEmail, name);
  await recordSecret(freshToken);
  const accepted = await member.post("/api/workspace-invitations/acceptance", {
    data: { token: freshToken },
  });
  expect(accepted.status()).toBe(200);
  expect((await bearerGet(admin, "/api/agents/me", key)).status()).toBe(401);
  const freshKey = await issueKey(member, agentId, workspaceId, []);
  const freshMe = await bearerGet(admin, "/api/agents/me", freshKey);
  expect(freshMe.status()).toBe(200);
  expect(await freshMe.json()).toMatchObject({ projects: [] });

  const history = await admin.get(`/api/workspaces/${workspaceId}/history`);
  expect(history.status()).toBe(200);
  const events = asArray(await history.json());
  expect(events.some((event) => field(event, "type") === "member_removed")).toBe(true);
});

test("voluntary leave works and the last owner is blocked", async () => {
  const name = `Leaving Team ${randomUUID()}`;
  const created = await admin.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspaceId = idOf(await created.json(), "workspace");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Leaving project" },
  });
  expect(project.status()).toBe(201);
  const projectId = idOf(await project.json(), "project");
  await registerMember({ name, workspaceId, projectId, level: "read" });

  const left = await member.post(`/api/workspaces/${workspaceId}/leave`);
  expect(left.status()).toBe(204);
  const directory = await admin.get(`/api/workspaces/${workspaceId}/members`);
  const members = asArray(await directory.json());
  expect(members.some((row) => field(row, "email") === memberEmail)).toBe(false);

  const blocked = await admin.post(`/api/workspaces/${workspaceId}/leave`);
  expect(blocked.status()).toBe(409);
  expect(await blocked.json()).toMatchObject({ status: 409, code: "last_owner" });

  const history = await admin.get(`/api/workspaces/${workspaceId}/history`);
  expect(history.status()).toBe(200);
  const events = asArray(await history.json());
  expect(events.some((event) => field(event, "type") === "member_left")).toBe(true);
});
