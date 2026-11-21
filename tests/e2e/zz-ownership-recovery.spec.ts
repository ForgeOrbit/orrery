import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_PASSWORD = "ownership-recovery-member-password";
const PROJECT_NAME = "Secret Recovery Project";
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

async function recoveryMailDelivered(to: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const list = await admin.get(`${mailpit}/api/v1/messages`);
        const body: unknown = await list.json();
        for (const message of asArray(field(body, "messages"))) {
          if (field(message, "Subject") !== "Workspace ownership recovered") continue;
          const id = field(message, "ID");
          if (typeof id !== "string") continue;
          const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
          const caught: unknown = await detail.json();
          const addresses = asArray(field(caught, "To")).flatMap((entry) => {
            const address = field(entry, "Address");
            return typeof address === "string" ? [address] : [];
          });
          if (addresses.includes(to)) return true;
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

let admin: APIRequestContext;
let member: APIRequestContext;

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

test("the minimal directory, refusals, recovery, notification and no admin project access", async () => {
  const workspaceName = `Recovery Team ${randomUUID()}`;
  const created = await admin.post("/api/workspaces", { data: { name: workspaceName } });
  expect(created.status()).toBe(201);
  const workspaceId = idOf(await created.json(), "workspace");

  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: PROJECT_NAME },
  });
  expect(project.status()).toBe(201);
  const projectId = idOf(await project.json(), "project");

  const memberEmail = `ownership.member.${randomUUID()}@orrery.test`;
  await recordSecret(MEMBER_PASSWORD);
  const invitation = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: memberEmail, projectGrants: [{ projectId, level: "contribute" }] },
  });
  expect(invitation.status()).toBe(201);
  const token = await liveInvitationToken(admin, memberEmail, workspaceName);
  await recordSecret(token);
  const registration = await member.post("/api/workspace-invitations/registration", {
    data: { token, password: MEMBER_PASSWORD },
  });
  expect(registration.status()).toBe(200);
  const memberLogin = await member.post("/api/auth/login", {
    data: { email: memberEmail, password: MEMBER_PASSWORD },
  });
  expect(memberLogin.status()).toBe(200);

  const directoryBefore = await admin.get(`/api/workspaces/${workspaceId}/members`);
  expect(directoryBefore.status()).toBe(200);
  const target = asArray(await directoryBefore.json()).find(
    (row) => field(row, "email") === memberEmail,
  );
  const memberId = requiredText(field(target, "humanId"), "the member id");

  const appointed = await admin.post(`/api/workspaces/${workspaceId}/owners`, {
    data: { humanId: memberId },
  });
  expect(appointed.status()).toBe(200);

  const left = await admin.post(`/api/workspaces/${workspaceId}/leave`);
  expect(left.status()).toBe(204);

  const refused = await admin.post(`/api/admin/workspaces/${workspaceId}/recover-ownership`, {
    data: { humanId: memberId },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: "workspace_has_active_owner" });

  const directory = await admin.get("/api/admin/workspaces");
  expect(directory.status()).toBe(200);
  const directoryBody: unknown = await directory.json();
  const serialized = JSON.stringify(directoryBody);
  expect(serialized).not.toContain(PROJECT_NAME);
  expect(serialized).not.toContain(projectId);
  expect(serialized).not.toContain('"projectId"');
  const entry = asArray(directoryBody).find((row) => field(row, "id") === workspaceId);
  expect(entry).toBeDefined();
  expect(field(entry, "kind")).toBe("shared");
  expect(field(entry, "hasActiveOwner")).toBe(true);

  const history = await admin.get("/api/installation/history");
  expect(history.status()).toBe(200);
  const bootstrap = asArray(await history.json()).find(
    (event) => field(event, "type") === "installation_bootstrap",
  );
  const adminId = requiredText(field(field(bootstrap, "actor"), "humanId"), "the administrator id");

  const deactivated = await admin.post(`/api/admin/accounts/${memberId}/deactivate`, { data: {} });
  expect(deactivated.status()).toBe(200);
  const reactivated = await admin.post(`/api/admin/accounts/${memberId}/reactivate`, { data: {} });
  expect(reactivated.status()).toBe(200);

  const ownerless = await admin.get("/api/admin/workspaces");
  expect(ownerless.status()).toBe(200);
  const ownerlessEntry = asArray(await ownerless.json()).find(
    (row) => field(row, "id") === workspaceId,
  );
  expect(field(ownerlessEntry, "hasActiveOwner")).toBe(false);
  const status = asArray(field(ownerlessEntry, "members")).find(
    (row) => field(row, "humanId") === memberId,
  );
  expect(field(status, "isFormerOwner")).toBe(true);
  expect(field(status, "suspendedAt")).not.toBeNull();
  expect(field(status, "accountDeactivated")).toBe(false);

  const selfPromotion = await admin.post(`/api/admin/workspaces/${workspaceId}/recover-ownership`, {
    data: { humanId: adminId },
  });
  expect(selfPromotion.status()).toBe(403);
  expect(await selfPromotion.json()).toMatchObject({ code: "self_recovery_forbidden" });

  const recovery = await admin.post(`/api/admin/workspaces/${workspaceId}/recover-ownership`, {
    data: { humanId: memberId },
  });
  expect(recovery.status()).toBe(200);
  expect(await recovery.json()).toMatchObject({ workspaceId, humanId: memberId });

  const memberLoginAgain = await member.post("/api/auth/login", {
    data: { email: memberEmail, password: MEMBER_PASSWORD },
  });
  expect(memberLoginAgain.status()).toBe(200);
  const memberWorkspaces = await member.get("/api/workspaces");
  expect(memberWorkspaces.status()).toBe(200);
  const owned = asArray(await memberWorkspaces.json()).find(
    (row) => field(row, "id") === workspaceId,
  );
  expect(field(owned, "isOwner")).toBe(true);
  const memberHistory = await member.get(`/api/workspaces/${workspaceId}/history`);
  expect(memberHistory.status()).toBe(200);
  expect(asArray(await memberHistory.json()).map((event) => field(event, "type"))).toContain(
    "workspace_ownership_recovered",
  );
  const adminHistory = await admin.get("/api/installation/history");
  expect(adminHistory.status()).toBe(200);
  expect(asArray(await adminHistory.json()).map((event) => field(event, "type"))).toContain(
    "workspace_ownership_recovered",
  );

  await recoveryMailDelivered(memberEmail);

  expect((await admin.get(`/api/workspaces/${workspaceId}`)).status()).toBe(404);
  expect((await admin.get(`/api/projects/${projectId}/issues`)).status()).toBe(404);
  const adminWorkspaces = await admin.get("/api/workspaces");
  expect(
    asArray(await adminWorkspaces.json()).some((row) => field(row, "id") === workspaceId),
  ).toBe(false);
});
