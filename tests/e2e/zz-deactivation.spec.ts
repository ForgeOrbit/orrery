import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_PASSWORD = "deactivation-member-password";
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

async function liveInvitationToken(
  client: APIRequestContext,
  to: string,
  workspaceName: string,
): Promise<string> {
  let live: string | undefined;
  await expect
    .poll(
      async () => {
        const list = await client.get(`${mailpit}/api/v1/messages`);
        const body: unknown = await list.json();
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
          if (token === undefined) continue;
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

test("deactivation stops login, sessions and keys; reactivation restores only personal work", async () => {
  const name = `Deactivation Team ${randomUUID()}`;
  const created = await admin.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspaceId = idOf(await created.json(), "workspace");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Deactivation project" },
  });
  expect(project.status()).toBe(201);
  const projectId = idOf(await project.json(), "project");

  memberEmail = `deactivation.member.${randomUUID()}@orrery.test`;
  const invitation = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: memberEmail, projectGrants: [{ projectId, level: "contribute" }] },
  });
  expect(invitation.status()).toBe(201);
  const token = await liveInvitationToken(admin, memberEmail, name);
  await recordSecret(token);
  const registration = await member.post("/api/workspace-invitations/registration", {
    data: { token, password: MEMBER_PASSWORD },
  });
  expect(registration.status()).toBe(200);
  await signInMember();

  const agent = await member.post("/api/agents", {
    data: { name: `deactivation-bot-${randomUUID()}` },
  });
  expect(agent.status()).toBe(201);
  const agentId = idOf(await agent.json(), "agent");
  const issued = await member.post("/api/agents/keys", {
    data: { agentId, workspaceId, validity: "90", projects: [{ projectId, level: "contribute" }] },
  });
  expect(issued.status()).toBe(201);
  const secret = requiredText(field(await issued.json(), "secret"), "the key secret");
  await recordSecret(secret);
  expect((await bearerGet(admin, "/api/agents/me", secret)).status()).toBe(200);

  const directory = await admin.get(`/api/workspaces/${workspaceId}/members`);
  expect(directory.status()).toBe(200);
  const target = asArray(await directory.json()).find((row) => field(row, "email") === memberEmail);
  const humanId = requiredText(field(target, "humanId"), "the member id");

  const deactivated = await admin.post(`/api/admin/accounts/${humanId}/deactivate`, { data: {} });
  expect(deactivated.status()).toBe(200);
  expect(await deactivated.json()).toMatchObject({ humanId, email: memberEmail });

  expect((await member.get("/api/auth/session")).status()).toBe(401);
  const refusedLogin = await member.post("/api/auth/login", {
    data: { email: memberEmail, password: MEMBER_PASSWORD },
  });
  expect(refusedLogin.status()).toBe(401);
  expect(await refusedLogin.json()).toMatchObject({ code: "invalid_credentials" });
  const refusedKey = await bearerGet(admin, "/api/agents/me", secret);
  expect(refusedKey.status()).toBe(401);
  expect(await refusedKey.json()).toMatchObject({ code: "human_deactivated" });

  const reactivated = await admin.post(`/api/admin/accounts/${humanId}/reactivate`, { data: {} });
  expect(reactivated.status()).toBe(200);
  expect(await reactivated.json()).toMatchObject({ deactivatedAt: null });

  await signInMember();
  const workspaces = await member.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const names = asArray(await workspaces.json()).map((row) => field(row, "name"));
  expect(names).toContain("Personal");
  expect(names).not.toContain(name);
  expect((await member.get(`/api/workspaces/${workspaceId}`)).status()).toBe(404);

  const oldKey = await bearerGet(admin, "/api/agents/me", secret);
  expect(oldKey.status()).toBe(401);
  expect(await oldKey.json()).toMatchObject({ code: "key_revoked" });

  const history = await admin.get("/api/installation/history");
  expect(history.status()).toBe(200);
  const types = asArray(await history.json()).map((event) => field(event, "type"));
  expect(types).toContain("account_deactivated");
  expect(types).toContain("account_reactivated");
});

test("the last active system administrator cannot be deactivated", async () => {
  const history = await admin.get("/api/installation/history");
  expect(history.status()).toBe(200);
  const bootstrap = asArray(await history.json()).find(
    (event) => field(event, "type") === "installation_bootstrap",
  );
  const target = requiredText(field(field(bootstrap, "actor"), "humanId"), "the administrator id");
  const blocked = await admin.post(`/api/admin/accounts/${target}/deactivate`, { data: {} });
  expect(blocked.status()).toBe(409);
  expect(await blocked.json()).toMatchObject({ code: "last_admin" });
});
