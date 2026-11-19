import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Problem,
  Workspace,
  WorkspaceInvitation,
  WorkspaceInvitationPreview,
  WorkspaceMember,
  WorkspaceMembersResponse,
  WorkspacesResponse,
  type SmtpSettings,
} from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccountsFeature } from "../accounts/index.ts";
import { createInvitationsFeature } from "../invitations/index.ts";
import { createSettingsFeature } from "../settings/index.ts";
import {
  browserSessions,
  humans,
  workspaceEvents,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createWorkspacesFeature } from "./index.ts";

// Runs against a real Postgres (see AGENTS.md): memberships, ownership invariants,
// invitation redemption, and the recorded access events are database behavior, not mock
// behavior. Delivery is faked at the transport; the black-box e2e suite proves real
// delivery through Mailpit.

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const INVITEE_INPUT = "  Member@Example.COM ";
const INVITEE = "member@example.com";
const SMTP: SmtpSettings = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  username: null,
  password: null,
  from: "orrery@example.test",
};

const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const putJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const deleteRequest = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const problemBody = async (res: Response) => Problem.parse(await res.json());

const tokenFrom = (text: string, path = "workspace-invitation") =>
  text.match(new RegExp(`/${path}\\?token=([A-Za-z0-9_-]+)`))?.[1];

// The shared story so far: the first administrator exists (bootstrap) and is signed in.
async function bootstrapAdmin(app: Hono) {
  const res = await postJson(app, "/api/setup/admin", {
    secret: SECRET,
    email: EMAIL,
    password: PASSWORD,
  });
  expect(res.status).toBe(201);
}

async function cookieFor(app: Hono, email: string, password: string) {
  const res = await postJson(app, "/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  return cookie;
}

async function saveSmtp(app: Hono, cookie: string) {
  const res = await putJson(app, "/api/settings/smtp", SMTP, cookie);
  expect(res.status).toBe(200);
}

// A verified account with a live session, created directly: the point is the workspace
// flow, not repeating the installation invitation story.
async function verifiedCookie(app: Hono, email: string) {
  const [human] = await insertHuman({ email, verified: true });
  return { human, cookie: await sessionFor(app, human.id) };
}

async function insertHuman(input: { email: string; verified: boolean }) {
  const database = currentDatabase();
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      // One normalization, the same as the contract and the humans CHECK.
      email: input.email.trim().toLowerCase(),
      passwordHash: "scrypt$anything",
      ...(input.verified ? { emailVerifiedAt: sql`now()` } : {}),
    })
    .returning();
  if (human === undefined) throw new Error("the account was not created");
  return [human] as const;
}

// The database every helper in this file uses. Set by the suite's beforeAll; keeping the
// service tests and fixtures on one connection pool is deliberate.
let databaseForHelpers: Database;
const currentDatabase = () => databaseForHelpers;

async function sessionFor(app: Hono, humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await currentDatabase()
    .db.insert(browserSessions)
    .values({
      id: randomUUID(),
      humanId,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
  return `orrery_session=${token}`;
}

async function verifyHuman(humanId: string) {
  await currentDatabase()
    .db.update(humans)
    .set({ emailVerifiedAt: sql`now()` })
    .where(eq(humans.id, humanId));
}

async function workspaceInviteToken(
  sent: { to: string; text: string }[],
  email: string,
  name: string,
) {
  const mail = sent.find(
    (candidate) => candidate.to === email && candidate.text.includes(`"${name}"`),
  );
  const token = mail === undefined ? undefined : tokenFrom(mail.text);
  if (token === undefined) throw new Error("the workspace invitation email carried no token");
  return token;
}

async function createWorkspace(app: Hono, cookie: string, name = "Rocket Team") {
  const res = await postJson(app, "/api/workspaces", { name }, cookie);
  expect(res.status).toBe(201);
  return Workspace.parse(await res.json());
}

async function invite(app: Hono, cookie: string, workspaceId: string, email: string) {
  const res = await postJson(app, `/api/workspaces/${workspaceId}/invitations`, { email }, cookie);
  expect(res.status).toBe(201);
  return WorkspaceInvitation.parse(await res.json());
}

async function listing(app: Hono, cookie: string) {
  const res = await getJson(app, "/api/workspaces", cookie);
  expect(res.status).toBe(200);
  return WorkspacesResponse.parse(await res.json());
}

describe("workspaces", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    databaseForHelpers = database;
    const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  afterEach(async () => {
    await database.db.execute(
      sql`truncate workspace_events, workspace_invitations, workspace_memberships, invitations, humans, workspaces, browser_sessions, instance_setup, instance_settings, email_verification_tokens`,
    );
  });

  // Wired like features/index.ts, with a fake transport that keeps the emails, so the
  // invitation token can be read back the way a recipient would.
  function makeApp() {
    const sent: { to: string; subject: string; text: string }[] = [];
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const settings = createSettingsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      encryptionKey: undefined,
      sessionReader: accounts.sessionReader,
      markEmailVerified: accounts.markEmailVerified,
      sendMail: async (_settings, mail) => {
        sent.push({ to: mail.to, subject: mail.subject, text: mail.text });
      },
      log: silentLogger,
    });
    const invitationsFeature = createInvitationsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      emailRegistered: accounts.emailRegistered,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log: silentLogger,
    });
    const workspacesFeature = createWorkspacesFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log: silentLogger,
    });
    const app = createApp({
      features: [accounts, settings, invitationsFeature, workspacesFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    return { app, sent };
  }

  // The setup every workspace test starts from: the administrator is signed in, verified,
  // and SMTP is saved, so an invitation can actually deliver.
  async function readyApp() {
    const made = makeApp();
    await bootstrapAdmin(made.app);
    await saveSmtp(made.app, await cookieFor(made.app, EMAIL, PASSWORD));
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");
    await verifyHuman(admin.id);
    return { ...made, admin, adminCookie: await cookieFor(made.app, EMAIL, PASSWORD) };
  }

  async function eventsFor(workspaceId: string) {
    return database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspaceId))
      .orderBy(workspaceEvents.createdAt, workspaceEvents.id);
  }

  it("refuses every workspace operation without a signed-in account", async () => {
    const { app } = makeApp();
    await bootstrapAdmin(app);
    const workspace = await createWorkspace(app, await cookieFor(app, EMAIL, PASSWORD));

    const attempts = [
      await getJson(app, "/api/workspaces"),
      await getJson(app, `/api/workspaces/${workspace.id}`),
      await postJson(app, "/api/workspaces", { name: "Nope" }),
      await postJson(app, `/api/workspaces/${workspace.id}/invitations`, { email: INVITEE }),
      await postJson(app, "/api/workspace-invitations/acceptance", { token: "x" }),
      await postJson(app, `/api/workspaces/${workspace.id}/owners`, { humanId: "x" }),
      await deleteRequest(app, `/api/workspaces/${workspace.id}/members/x`),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 401, code: "not_signed_in" });
    }
  });

  it("creates a shared workspace with the creator as owner, and records the event", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const created = await createWorkspace(app, adminCookie, "  Rocket Team  ");
    expect(created).toMatchObject({
      kind: "shared",
      name: "Rocket Team",
      isOwner: true,
    });

    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, created.id));
    expect(membership).toMatchObject({ humanId: admin.id, isOwner: true });

    const events = await eventsFor(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "workspace_created",
      actorHumanId: admin.id,
      subjectHumanId: admin.id,
    });

    // The listing keeps the personal workspace and the shared one as distinct views.
    const workspacesList = await listing(app, adminCookie);
    expect(workspacesList.filter((workspace) => workspace.kind === "personal")).toHaveLength(1);
    expect(workspacesList.filter((workspace) => workspace.kind === "shared")).toEqual([created]);

    const detail = await getJson(app, `/api/workspaces/${created.id}`, adminCookie);
    expect(detail.status).toBe(200);
    expect(Workspace.parse(await detail.json())).toEqual(created);

    const members = await getJson(app, `/api/workspaces/${created.id}/members`, adminCookie);
    expect(members.status).toBe(200);
    expect(WorkspaceMembersResponse.parse(await members.json())).toEqual([
      { humanId: admin.id, email: EMAIL, isOwner: true },
    ]);

    // Another signed-in person sees neither the workspace nor its detail.
    const { cookie: otherCookie } = await verifiedCookie(app, "outsider@example.com");
    expect((await listing(app, otherCookie)).map((workspace) => workspace.id)).not.toContain(
      created.id,
    );
    const hidden = await getJson(app, `/api/workspaces/${created.id}`, otherCookie);
    expect(hidden.status).toBe(404);
    expect(await problemBody(hidden)).toMatchObject({ code: "workspace_not_found" });
    const hiddenMembers = await getJson(app, `/api/workspaces/${created.id}/members`, otherCookie);
    expect(hiddenMembers.status).toBe(403);
    expect(await problemBody(hiddenMembers)).toMatchObject({ code: "not_workspace_owner" });
  });

  it("requires a verified owner to invite", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);

    // The bootstrap administrator starts unverified; creating a workspace does not
    // require it, but the invitation that could create a new account does.
    await database.db.update(humans).set({ emailVerifiedAt: null }).where(eq(humans.id, admin.id));
    const unverified = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      adminCookie,
    );
    expect(unverified.status).toBe(403);
    expect(await problemBody(unverified)).toMatchObject({ code: "inviter_unverified" });
    expect(await database.db.select().from(workspaceInvitations)).toHaveLength(0);

    // A signed-in non-member is not an owner and cannot invite either.
    const { cookie: outsiderCookie } = await verifiedCookie(app, "outsider@example.com");
    await verifyHuman(admin.id);
    const outsider = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      outsiderCookie,
    );
    expect(outsider.status).toBe(403);
    expect(await problemBody(outsider)).toMatchObject({ code: "not_workspace_owner" });
  });

  it("lets an existing verified account accept, matching normalized emails on both sides", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, "Member@Example.COM");

    // The invitation normalizes its input exactly like the account's stored email.
    const invitation = await invite(app, adminCookie, workspace.id, "  MEMBER@example.com ");
    expect(invitation).toEqual({
      workspaceId: workspace.id,
      email: "member@example.com",
      status: "pending",
    });
    const token = await workspaceInviteToken(sent, "member@example.com", "Rocket Team");

    // The forwarded link, opened by a different signed-in account, is refused and the
    // token stays pending: the refusal must not burn the recipient's link.
    const forwardedPreview = await getJson(
      app,
      `/api/workspace-invitations/preview?token=${token}`,
    );
    expect(forwardedPreview.status).toBe(200);
    expect(WorkspaceInvitationPreview.parse(await forwardedPreview.json())).toEqual({
      workspaceId: workspace.id,
      workspaceName: "Rocket Team",
      email: "member@example.com",
    });
    const forwarded = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      adminCookie,
    );
    expect(forwarded.status).toBe(403);
    expect(await problemBody(forwarded)).toMatchObject({
      code: "invitation_recipient_mismatch",
    });
    const [stillPending] = await database.db.select().from(workspaceInvitations);
    expect(stillPending).toMatchObject({ status: "pending", acceptedAt: null });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    // The invited, verified account accepts once.
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(accepted.status).toBe(200);
    expect(Workspace.parse(await accepted.json())).toEqual({
      id: workspace.id,
      kind: "shared",
      name: "Rocket Team",
      isOwner: false,
    });
    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, member.id));
    expect(membership).toMatchObject({ workspaceId: workspace.id, isOwner: false });
    const [acceptedRow] = await database.db.select().from(workspaceInvitations);
    expect(acceptedRow).toMatchObject({ status: "accepted", email: "member@example.com" });
    expect(acceptedRow?.acceptedAt).not.toBeNull();
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "member_joined",
    ]);
    expect((await listing(app, memberCookie)).map((item) => item.id)).toContain(workspace.id);

    // A token is accepted exactly once.
    const reused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(reused.status).toBe(400);
    expect(await problemBody(reused)).toMatchObject({ code: "invitation_invalid" });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(2);
  });

  it("refuses an unverified matching account until its email is verified", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const [unverified] = await insertHuman({ email: INVITEE, verified: false });
    const unverifiedCookie = await sessionFor(app, unverified.id);

    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");

    const refused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      unverifiedCookie,
    );
    expect(refused.status).toBe(403);
    expect(await problemBody(refused)).toMatchObject({ code: "email_unverified" });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    // Verification is the account's own property; once earned, the pending link works.
    await verifyHuman(unverified.id);
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      unverifiedCookie,
    );
    expect(accepted.status).toBe(200);
  });

  it("registers a new email with its account, personal workspace, membership, and verified mark in one flow", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    await invite(app, adminCookie, workspace.id, "  New.Member@Example.COM ");
    const token = await workspaceInviteToken(sent, "new.member@example.com", "Rocket Team");

    // Preview is a read: it changes nothing and works before sign-in.
    const preview = await getJson(app, `/api/workspace-invitations/preview?token=${token}`);
    expect(preview.status).toBe(200);
    expect(WorkspaceInvitationPreview.parse(await preview.json())).toEqual({
      workspaceId: workspace.id,
      workspaceName: "Rocket Team",
      email: "new.member@example.com",
    });
    // No account and no membership exist before the POST.
    expect(await database.db.select().from(humans)).toHaveLength(1);
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    const registered = await postJson(app, "/api/workspace-invitations/registration", {
      token,
      password: "new-member-password",
    });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({
      email: "new.member@example.com",
      emailVerified: true,
    });

    const [human] = await database.db
      .select()
      .from(humans)
      .where(eq(humans.email, "new.member@example.com"));
    expect(human).toMatchObject({ isSystemAdministrator: false });
    expect(human?.emailVerifiedAt).not.toBeNull();
    expect(human?.passwordHash).toMatch(/^scrypt\$/);
    expect(
      await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, human?.id ?? "")),
    ).toHaveLength(1);
    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, human?.id ?? ""));
    expect(membership).toMatchObject({ workspaceId: workspace.id, isOwner: false });
    const [invitation] = await database.db.select().from(workspaceInvitations);
    expect(invitation).toMatchObject({ status: "accepted" });
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "member_joined",
    ]);

    // The account is real and verified; its personal workspace is separate.
    const login = await postJson(app, "/api/auth/login", {
      email: "new.member@example.com",
      password: "new-member-password",
    });
    expect(login.status).toBe(200);
    const newCookie = await cookieFor(app, "new.member@example.com", "new-member-password");
    const workspacesList = await listing(app, newCookie);
    expect(workspacesList.map((item) => item.kind).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "personal",
      "shared",
    ]);

    // A structural failure leaves no partial account, membership, or consumed token.
    const [other] = await insertHuman({ email: "pending@example.com", verified: false });
    await invite(app, adminCookie, workspace.id, "pending@example.com");
    const pendingToken = await workspaceInviteToken(sent, "pending@example.com", "Rocket Team");
    await verifyHuman(other.id);
    const existing = await postJson(app, "/api/workspace-invitations/registration", {
      token: pendingToken,
      password: "existing-password",
    });
    expect(existing.status).toBe(409);
    expect(await problemBody(existing)).toMatchObject({ code: "account_exists" });
    const pendingRow = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, tokenHash(pendingToken)));
    expect(pendingRow[0]).toMatchObject({ status: "pending", acceptedAt: null });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, other.id)),
    ).toHaveLength(0);
  });

  it("appoints another owner and lets any owner appoint, while non-owners are refused", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    expect(
      (await postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie))
        .status,
    ).toBe(200);

    // A member cannot appoint owners before being appointed.
    const memberAttempt = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: member.id },
      memberCookie,
    );
    expect(memberAttempt.status).toBe(403);
    expect(await problemBody(memberAttempt)).toMatchObject({ code: "not_workspace_owner" });

    const appointed = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: member.id },
      adminCookie,
    );
    expect(appointed.status).toBe(200);
    expect(WorkspaceMember.parse(await appointed.json())).toEqual({
      humanId: member.id,
      email: INVITEE,
      isOwner: true,
    });
    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, member.id));
    expect(membership?.isOwner).toBe(true);
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "member_joined",
      "owner_appointed",
    ]);
    expect(
      (await listing(app, memberCookie)).find((item) => item.id === workspace.id)?.isOwner,
    ).toBe(true);

    // Appointment is idempotent and adds no duplicate event; a non-member is refused.
    const again = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: member.id },
      adminCookie,
    );
    expect(again.status).toBe(200);
    expect(
      (await eventsFor(workspace.id)).filter((event) => event.type === "owner_appointed"),
    ).toHaveLength(1);
    const missing = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: randomUUID() },
      adminCookie,
    );
    expect(missing.status).toBe(404);
    expect(await problemBody(missing)).toMatchObject({ code: "member_not_found" });
  });

  it("protects the last owner, and a shared workspace survives one of two owners leaving", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);

    const lastOwner = await deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${admin.id}`,
      adminCookie,
    );
    expect(lastOwner.status).toBe(409);
    expect(lastOwner.headers.get("content-type")).toBe("application/problem+json");
    expect(await problemBody(lastOwner)).toMatchObject({ status: 409, code: "last_owner" });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
    ]);

    // The database's deferred trigger refuses a last-owner deletion even when the
    // service is bypassed, so the invariant is not only an application check.
    const rejected = await database.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
      .then(
        () => {
          throw new Error("expected the last owner to be protected");
        },
        (cause: unknown) => cause,
      );
    expect(rootCause(rejected)?.message ?? String(rejected)).toContain(
      "must keep at least one owner",
    );
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    // With a second owner, one can leave and the workspace keeps its remaining owner.
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: second.id,
      isOwner: true,
    });
    const removed = await deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${second.id}`,
      adminCookie,
    );
    expect(removed.status).toBe(204);
    const remaining = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ humanId: admin.id, isOwner: true });
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "owner_removed",
    ]);
  });

  it("settles two owners removing each other with exactly one winner and one owner left", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: second.id,
      isOwner: true,
    });
    const secondCookie = await sessionFor(app, second.id);

    const [first, other] = await Promise.all([
      deleteRequest(app, `/api/workspaces/${workspace.id}/members/${second.id}`, adminCookie),
      deleteRequest(app, `/api/workspaces/${workspace.id}/members/${admin.id}`, secondCookie),
    ]);
    expect([first.status, other.status].toSorted((a, b) => a - b)).toEqual([204, 403]);

    const remaining = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.isOwner).toBe(true);
    expect(
      (await eventsFor(workspace.id)).filter((event) => event.type === "owner_removed"),
    ).toHaveLength(1);
  });

  it("refuses a second pending invitation, but re-invites after the seven days expire", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    await invite(app, adminCookie, workspace.id, INVITEE);

    const duplicate = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      adminCookie,
    );
    expect(duplicate.status).toBe(409);
    expect(await problemBody(duplicate)).toMatchObject({ code: "invitation_pending" });

    // A row just past its deadline is superseded in place, and its old token is dead.
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(workspaceInvitations.workspaceId, workspace.id));
    const reInvited = await invite(app, adminCookie, workspace.id, INVITEE);
    expect(reInvited.status).toBe("pending");
    const rows = await database.db.select().from(workspaceInvitations);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "expired")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);

    // The expired token cannot preview or accept.
    const expiredToken = tokenFrom(sent[0]?.text ?? "") ?? "";
    const preview = await getJson(app, `/api/workspace-invitations/preview?token=${expiredToken}`);
    expect(preview.status).toBe(400);
    expect(await problemBody(preview)).toMatchObject({ code: "invitation_invalid" });
  });
});
