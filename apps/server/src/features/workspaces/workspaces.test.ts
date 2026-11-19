import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  InvitationSummaries,
  InvitationSummary,
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
import { and, eq, sql } from "drizzle-orm";
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

const postEmpty = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "POST", ...(cookie ? { headers: { cookie } } : {}) });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const problemBody = async (res: Response) => Problem.parse(await res.json());

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

// Drizzle wraps the driver's error; the root's message (the PostgresError's) carries the
// trigger's message. Resolves with that, or the stringified error.
async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
}

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

// A one-way latch for coordinating two database sessions without using a sleep as the
// synchronization signal.
function createGate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    opened,
    release: () => release(),
  };
}

// Waits until a statement in another session is blocked on a lock whose query contains
// the given text. Polling pg_stat_activity coordinates the test deterministically.
async function waitForLockWait(pattern: string) {
  await expect
    .poll(
      async () => {
        const [row] = await currentDatabase().sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike ${`%${pattern}%`}
            and pid <> pg_backend_pid()
        `;
        return row?.count ?? 0;
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBeGreaterThan(0);
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

async function invitationList(app: Hono, cookie: string, workspaceId: string) {
  const res = await getJson(app, `/api/workspaces/${workspaceId}/invitations`, cookie);
  expect(res.status).toBe(200);
  return InvitationSummaries.parse(await res.json());
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
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`delete from workspace_events`);
      await tx.execute(sql`delete from workspace_invitations`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from invitations`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from instance_settings`);
      await tx.execute(sql`delete from email_verification_tokens`);
      await tx.execute(sql`delete from humans`);
    });
  });

  // Wired like features/index.ts, with a fake transport that keeps the emails, so the
  // invitation token can be read back the way a recipient would.
  function makeApp() {
    const sent: { to: string; subject: string; text: string }[] = [];
    let deliveryFailure: (() => Error) | undefined;
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
        if (deliveryFailure !== undefined) throw deliveryFailure();
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
    return {
      app,
      sent,
      failDelivery(errorFactory: () => Error) {
        deliveryFailure = errorFactory;
      },
      repairDelivery() {
        deliveryFailure = undefined;
      },
    };
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

  // A valid shared workspace written directly, for tests about the database invariant
  // rather than the HTTP flow. The owner rows can be inserted in the same transaction.
  async function directSharedWorkspace(ownerIds: readonly string[], name = "Direct Team") {
    const workspaceId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id: workspaceId, kind: "shared", name });
      for (const humanId of ownerIds) {
        await tx.insert(workspaceMemberships).values({
          id: randomUUID(),
          workspaceId,
          humanId,
          isOwner: true,
        });
      }
    });
    return workspaceId;
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
      invitedByEmail: EMAIL,
      grants: [
        {
          kind: "workspace_membership",
          workspaceId: workspace.id,
          role: "member",
        },
      ],
      expiresAt: expect.any(String),
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
      invitedByEmail: EMAIL,
      grants: [
        {
          kind: "workspace_membership",
          workspaceId: workspace.id,
          role: "member",
        },
      ],
      expiresAt: expect.any(String),
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

  it("answers invalid path ids with validation Problems", async () => {
    const { app, adminCookie } = await readyApp();
    const tooLong = "a".repeat(201);
    const attempts = [
      await getJson(app, `/api/workspaces/${tooLong}`, adminCookie),
      await getJson(app, `/api/workspaces/${tooLong}/members`, adminCookie),
      await deleteRequest(app, `/api/workspaces/${tooLong}/members/x`, adminCookie),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });
    }
  });

  it("refuses acceptance after the inviter loses authority, and leaves the token pending", async () => {
    const { app, sent, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");

    // A second owner makes it valid for the inviter to leave, after which the pending
    // offer no longer has authorization behind it.
    const [second] = await insertHuman({ email: "replacement.owner@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: second.id,
      isOwner: true,
    });
    expect(
      (await deleteRequest(app, `/api/workspaces/${workspace.id}/members/${admin.id}`, adminCookie))
        .status,
    ).toBe(204);

    const refused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(refused.status).toBe(403);
    expect(await problemBody(refused)).toMatchObject({ code: "inviter_not_authorized" });
    const [row] = await database.db.select().from(workspaceInvitations);
    expect(row).toMatchObject({ status: "pending", acceptedAt: null });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, member.id)),
    ).toHaveLength(0);
  });

  it("settles concurrent redemptions of one workspace token with one membership and one winner", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");

    const results = await Promise.all([
      postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie),
      postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie),
    ]);
    expect(results.map((res) => res.status).toSorted((a, b) => a - b)).toEqual([200, 400]);
    const memberships = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, member.id));
    expect(memberships).toHaveLength(1);
    expect(
      (await eventsFor(workspace.id)).filter((event) => event.type === "member_joined"),
    ).toHaveLength(1);
    const [row] = await database.db.select().from(workspaceInvitations);
    expect(row).toMatchObject({ status: "accepted" });
  });

  it("serializes an expired-token acceptance against its replacement", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const staleToken = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(workspaceInvitations.workspaceId, workspace.id));

    const [accept, replacement] = await Promise.all([
      postJson(app, "/api/workspace-invitations/acceptance", { token: staleToken }, memberCookie),
      postJson(app, `/api/workspaces/${workspace.id}/invitations`, { email: INVITEE }, adminCookie),
    ]);
    expect(accept.status).toBe(400);
    expect(await problemBody(accept)).toMatchObject({ code: "invitation_invalid" });
    expect(replacement.status).toBe(201);

    const rows = await database.db.select().from(workspaceInvitations);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "expired")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id)),
    ).toHaveLength(1); // the creator only
  });

  it("keeps invitation expiry separate from a failed delivery", async () => {
    const made = await readyApp();
    const { app, sent, adminCookie } = made;
    const workspace = await createWorkspace(app, adminCookie);
    made.failDelivery(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));

    const failed = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      adminCookie,
    );
    expect(failed.status).toBe(502);
    expect(await problemBody(failed)).toMatchObject({ code: "smtp_unreachable" });
    const [row] = await database.db.select().from(workspaceInvitations);
    expect(row).toMatchObject({ status: "pending", deliveryStatus: "failed" });
    expect(row?.acceptedAt).toBeNull();
    expect((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)).toBe(
      7 * 24 * 60 * 60 * 1000,
    );

    // Delivery failure is not expiry: the pending offer still blocks a replacement and
    // the failed link never redeems.
    const token = tokenFrom(sent[0]?.text ?? "") ?? "";
    const blocking = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      adminCookie,
    );
    expect(blocking.status).toBe(409);
    expect(await problemBody(blocking)).toMatchObject({ code: "invitation_pending" });
    const [stillPending] = await database.db.select().from(workspaceInvitations);
    expect(stillPending).toMatchObject({ status: "pending", deliveryStatus: "failed" });
    const preview = await getJson(app, `/api/workspace-invitations/preview?token=${token}`);
    expect(preview.status).toBe(400);
    expect(await problemBody(preview)).toMatchObject({ code: "invitation_invalid" });

    // Once the seven-day deadline passes, the row is expired in place and a fresh
    // invitation can be sent. Delivery status did not shorten or extend the deadline.
    made.repairDelivery();
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(workspaceInvitations.workspaceId, workspace.id));
    const replacement = await invite(app, adminCookie, workspace.id, INVITEE);
    expect(replacement.status).toBe("pending");
    const rows = await database.db.select().from(workspaceInvitations);
    expect(rows).toHaveLength(2);
    expect(rows.filter((candidate) => candidate.status === "expired")).toHaveLength(1);
    expect(rows.filter((candidate) => candidate.status === "pending")).toHaveLength(1);
  });

  it("lists every workspace invitation for an owner, with scope and delivery separate", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const other = randomUUID();
    await database.db.insert(workspaceInvitations).values([
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "pending@example.com",
        status: "pending",
        tokenHash: tokenHash("workspace-list-pending"),
        invitedByHumanId: admin.id,
        createdAt: sql`now() - interval '1 hour'`,
        expiresAt: sql`now() + interval '1 day'`,
        deliveryStatus: "sent",
        deliveryAttemptedAt: sql`now() - interval '1 minute'`,
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "accepted@example.com",
        status: "accepted",
        tokenHash: tokenHash("workspace-list-accepted"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 day'`,
        acceptedAt: sql`now() - interval '1 minute'`,
        deliveryStatus: "sent",
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "declined@example.com",
        status: "declined",
        tokenHash: tokenHash("workspace-list-declined"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 day'`,
        declinedAt: sql`now() - interval '1 minute'`,
        deliveryStatus: "sent",
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "expired@example.com",
        status: "expired",
        tokenHash: tokenHash("workspace-list-expired"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() - interval '1 day'`,
        expiredAt: sql`now() - interval '1 day'`,
        deliveryStatus: "sent",
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "revoked@example.com",
        status: "revoked",
        tokenHash: tokenHash("workspace-list-revoked"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 day'`,
        revokedAt: sql`now() - interval '1 minute'`,
        deliveryStatus: "failed",
        deliveryAttemptedAt: sql`now() - interval '2 minutes'`,
      },
    ]);

    const listed = await invitationList(app, adminCookie, workspace.id);
    expect(listed).toHaveLength(5);
    const byEmail = new Map(listed.map((invitation) => [invitation.email, invitation]));
    for (const invitation of listed) {
      expect(invitation).toMatchObject({
        target: { kind: "workspace", id: workspace.id, name: "Rocket Team" },
        grants: [
          {
            kind: "workspace_membership",
            workspaceId: workspace.id,
            role: "member",
          },
        ],
        invitedBy: { humanId: admin.id, email: EMAIL },
      });
    }
    expect(byEmail.get("pending@example.com")).toMatchObject({
      status: "pending",
      delivery: { status: "sent", attemptedAt: expect.any(String) },
      acceptedAt: null,
      declinedAt: null,
      expiredAt: null,
      revokedAt: null,
    });
    expect(byEmail.get("accepted@example.com")).toMatchObject({
      status: "accepted",
      acceptedAt: expect.any(String),
    });
    expect(byEmail.get("declined@example.com")).toMatchObject({
      status: "declined",
      declinedAt: expect.any(String),
    });
    expect(byEmail.get("expired@example.com")).toMatchObject({
      status: "expired",
      expiredAt: expect.any(String),
    });
    expect(byEmail.get("revoked@example.com")).toMatchObject({
      status: "revoked",
      revokedAt: expect.any(String),
      delivery: { status: "failed", attemptedAt: expect.any(String) },
    });

    // A member who does not own the workspace cannot read or manage its invitations.
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: member.id,
      isOwner: false,
    });
    const forbidden = [
      await getJson(app, `/api/workspaces/${workspace.id}/invitations`, memberCookie),
      await postEmpty(
        app,
        `/api/workspaces/${workspace.id}/invitations/${other}/resend`,
        memberCookie,
      ),
      await postEmpty(
        app,
        `/api/workspaces/${workspace.id}/invitations/${other}/revoke`,
        memberCookie,
      ),
    ];
    for (const res of forbidden) {
      expect(res.status).toBe(403);
      expect(await problemBody(res)).toMatchObject({ code: "not_workspace_owner" });
    }
    const anonymous = await getJson(app, `/api/workspaces/${workspace.id}/invitations`);
    expect(anonymous.status).toBe(401);
  });

  it("lets the inviter revoke and the recipient decline, and both links stop working", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const [pending] = await invitationList(app, adminCookie, workspace.id);
    if (pending === undefined) throw new Error("the invitation was not listed");

    const revoked = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${pending.id}/revoke`,
      adminCookie,
    );
    expect(revoked.status).toBe(200);
    expect(InvitationSummary.parse(await revoked.json())).toMatchObject({
      id: pending.id,
      status: "revoked",
      revokedAt: expect.any(String),
    });
    expect((await getJson(app, `/api/workspace-invitations/preview?token=${token}`)).status).toBe(
      400,
    );
    const refused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(refused.status).toBe(400);
    expect(await problemBody(refused)).toMatchObject({ code: "invitation_invalid" });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, member.id)),
    ).toHaveLength(0);

    // The recipient declines a second offer from the emailed link; holding the token is
    // the capability, so no session is needed.
    const declineEmail = "decline@example.com";
    await invite(app, adminCookie, workspace.id, declineEmail);
    const declineToken = await workspaceInviteToken(sent, declineEmail, "Rocket Team");
    const declined = await postJson(app, "/api/workspace-invitations/decline", {
      token: declineToken,
    });
    expect(declined.status).toBe(204);
    const again = await postJson(app, "/api/workspace-invitations/decline", {
      token: declineToken,
    });
    expect(again.status).toBe(400);
    expect(await problemBody(again)).toMatchObject({ code: "invitation_invalid" });
    expect(
      (await getJson(app, `/api/workspace-invitations/preview?token=${declineToken}`)).status,
    ).toBe(400);

    const history = await invitationList(app, adminCookie, workspace.id);
    expect(history.find((candidate) => candidate.id === pending.id)).toMatchObject({
      status: "revoked",
    });
    expect(history.find((candidate) => candidate.email === declineEmail)).toMatchObject({
      status: "declined",
      declinedAt: expect.any(String),
    });
  });

  it("resends a workspace invitation: the old link dies, history stays, and the deadline is seven fresh days", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const oldToken = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const [oldInvitation] = await invitationList(app, adminCookie, workspace.id);
    if (oldInvitation === undefined) throw new Error("the invitation was not listed");

    const resend = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${oldInvitation.id}/resend`,
      adminCookie,
    );
    expect(resend.status).toBe(200);
    const fresh = InvitationSummary.parse(await resend.json());
    expect(fresh).toMatchObject({
      email: INVITEE,
      status: "pending",
      target: { kind: "workspace", id: workspace.id, name: "Rocket Team" },
      delivery: { status: "sent", attemptedAt: expect.any(String) },
      acceptedAt: null,
      declinedAt: null,
      expiredAt: null,
      revokedAt: null,
    });
    expect(fresh.id).not.toBe(oldInvitation.id);
    const [oldRow] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, oldInvitation.id));
    expect(oldRow).toMatchObject({ status: "revoked" });
    expect(oldRow?.revokedAt).not.toBeNull();
    const [freshRow] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, fresh.id));
    expect(freshRow?.expiresAt.getTime() ?? 0).toBe(
      (freshRow?.createdAt.getTime() ?? 0) + 7 * 24 * 60 * 60 * 1000,
    );
    expect(sent).toHaveLength(2);
    const newToken = tokenFrom(sent[1]?.text ?? "");
    expect(newToken).not.toBe(oldToken);

    expect(
      (await getJson(app, `/api/workspace-invitations/preview?token=${oldToken}`)).status,
    ).toBe(400);
    const oldAttempt = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: oldToken },
      memberCookie,
    );
    expect(oldAttempt.status).toBe(400);
    expect(
      (await getJson(app, `/api/workspace-invitations/preview?token=${newToken}`)).status,
    ).toBe(200);
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: newToken },
      memberCookie,
    );
    expect(accepted.status).toBe(200);

    const history = await invitationList(app, adminCookie, workspace.id);
    expect(history.find((candidate) => candidate.id === oldInvitation.id)).toMatchObject({
      status: "revoked",
    });
    expect(history.find((candidate) => candidate.id === fresh.id)).toMatchObject({
      status: "accepted",
    });
  });

  it("resends workspace invitations on both sides of the expiry boundary with a fresh seven-day deadline", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    for (const email of ["just-before@example.com", "just-after@example.com"]) {
      await invite(app, adminCookie, workspace.id, email);
    }
    const listed = await invitationList(app, adminCookie, workspace.id);
    const before = listed.find((candidate) => candidate.email === "just-before@example.com");
    const after = listed.find((candidate) => candidate.email === "just-after@example.com");
    if (before === undefined || after === undefined) throw new Error("invitations missing");
    const beforeToken = await workspaceInviteToken(sent, "just-before@example.com", "Rocket Team");
    const afterToken = await workspaceInviteToken(sent, "just-after@example.com", "Rocket Team");

    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() + interval '1 second'` })
      .where(eq(workspaceInvitations.id, before.id));
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(workspaceInvitations.id, after.id));

    const resendBefore = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${before.id}/resend`,
      adminCookie,
    );
    expect(resendBefore.status).toBe(200);
    const freshBefore = InvitationSummary.parse(await resendBefore.json());
    const resendAfter = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${after.id}/resend`,
      adminCookie,
    );
    expect(resendAfter.status).toBe(200);
    const freshAfter = InvitationSummary.parse(await resendAfter.json());

    const rows = await database.db.select().from(workspaceInvitations);
    const oldBefore = rows.find((row) => row.id === before.id);
    const oldAfter = rows.find((row) => row.id === after.id);
    expect(oldBefore).toMatchObject({ status: "revoked" });
    expect(oldBefore?.revokedAt).not.toBeNull();
    expect(oldAfter).toMatchObject({ status: "expired" });
    expect(oldAfter?.expiredAt?.getTime()).toBe(oldAfter?.expiresAt.getTime());
    for (const fresh of [freshBefore, freshAfter]) {
      const row = rows.find((candidate) => candidate.id === fresh.id);
      expect(row?.expiresAt.getTime() ?? 0).toBe(
        (row?.createdAt.getTime() ?? 0) + 7 * 24 * 60 * 60 * 1000,
      );
      expect(fresh).toMatchObject({ status: "pending" });
    }
    // Both previous links stop working.
    for (const token of [beforeToken, afterToken]) {
      expect((await getJson(app, `/api/workspace-invitations/preview?token=${token}`)).status).toBe(
        400,
      );
    }
  });

  it("keeps a failed workspace resend delivery separate from the pending lifecycle", async () => {
    const made = await readyApp();
    const { app, sent, adminCookie } = made;
    const workspace = await createWorkspace(app, adminCookie);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const [invitation] = await invitationList(app, adminCookie, workspace.id);
    if (invitation === undefined) throw new Error("the invitation was not listed");

    made.failDelivery(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
    const failed = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${invitation.id}/resend`,
      adminCookie,
    );
    expect(failed.status).toBe(502);
    expect(await problemBody(failed)).toMatchObject({ code: "smtp_unreachable" });

    const after = await invitationList(app, adminCookie, workspace.id);
    expect(after).toHaveLength(2);
    const failedRow = after.find((candidate) => candidate.status === "pending");
    expect(failedRow).toMatchObject({
      status: "pending",
      delivery: { status: "failed", attemptedAt: expect.any(String) },
    });

    // The failed lifecycle is still resolvable: repair the relay and resend the new row.
    made.repairDelivery();
    if (failedRow === undefined) throw new Error("the replacement invitation is missing");
    const retried = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${failedRow.id}/resend`,
      adminCookie,
    );
    expect(retried.status).toBe(200);
    expect(InvitationSummary.parse(await retried.json())).toMatchObject({
      status: "pending",
      delivery: { status: "sent" },
    });
    expect(sent).toHaveLength(3); // original, failed resend, successful retry
  });

  it("refuses to resend or revoke a workspace invitation that is no longer pending or expired", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    expect(
      (await postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie))
        .status,
    ).toBe(200);
    const [invitation] = await invitationList(app, adminCookie, workspace.id);
    if (invitation === undefined) throw new Error("the invitation was not listed");

    for (const action of ["resend", "revoke"]) {
      const res = await postEmpty(
        app,
        `/api/workspaces/${workspace.id}/invitations/${invitation.id}/${action}`,
        adminCookie,
      );
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ code: "invitation_not_pending" });
    }
    const missing = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${randomUUID()}/revoke`,
      adminCookie,
    );
    expect(missing.status).toBe(404);
    expect(await problemBody(missing)).toMatchObject({ code: "invitation_not_found" });
  });

  it("enforces valid and invalid ownership states at the database, including moves", async () => {
    const { admin } = await readyApp();
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    const [third] = await insertHuman({ email: "third.member@example.com", verified: true });

    // A shared workspace created without an owner is invalid at commit.
    const orphanId = randomUUID();
    expect(
      await rejection(
        database.db.insert(workspaces).values({ id: orphanId, kind: "shared", name: "Orphan" }),
      ),
    ).toContain("must keep at least one owner");
    expect(
      await database.db.select().from(workspaces).where(eq(workspaces.id, orphanId)),
    ).toHaveLength(0);

    // Changing a personal workspace into a shared one without an owner is also refused.
    const [personal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, admin.id));
    expect(
      await rejection(
        database.db
          .update(workspaces)
          .set({ kind: "shared", personalOwnerHumanId: null })
          .where(eq(workspaces.id, personal?.id ?? "")),
      ),
    ).toContain("must keep at least one owner");
    const [stillPersonal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, personal?.id ?? ""));
    expect(stillPersonal?.kind).toBe("personal");

    // A last owner cannot be demoted by a direct update.
    const workspaceA = await directSharedWorkspace([admin.id], "Move A");
    const [aOwner] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceA));
    expect(
      await rejection(
        database.db
          .update(workspaceMemberships)
          .set({ isOwner: false })
          .where(eq(workspaceMemberships.id, aOwner?.id ?? "")),
      ),
    ).toContain("must keep at least one owner");
    const [stillOwner] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.id, aOwner?.id ?? ""));
    expect(stillOwner?.isOwner).toBe(true);

    // Moving the sole owner to another workspace would empty the old one, so the old id
    // is checked as well as the new one.
    const workspaceB = await directSharedWorkspace([second.id], "Move B");
    expect(
      await rejection(
        database.db
          .update(workspaceMemberships)
          .set({ workspaceId: workspaceB })
          .where(eq(workspaceMemberships.workspaceId, workspaceA)),
      ),
    ).toContain("must keep at least one owner");
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceA)),
    ).toHaveLength(1);

    // A non-owner membership can move when both workspaces keep an owner.
    const moving = randomUUID();
    await database.db.insert(workspaceMemberships).values({
      id: moving,
      workspaceId: workspaceA,
      humanId: third.id,
      isOwner: false,
    });
    await database.db
      .update(workspaceMemberships)
      .set({ workspaceId: workspaceB })
      .where(eq(workspaceMemberships.id, moving));
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.id, moving)),
    ).toMatchObject([{ workspaceId: workspaceB }]);

    // Deleting the memberships before the workspace is a valid transactional deletion.
    const removable = await directSharedWorkspace([admin.id], "Removable");
    await database.db.transaction(async (tx) => {
      await tx.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, removable));
      await tx.delete(workspaces).where(eq(workspaces.id, removable));
    });
    expect(
      await database.db.select().from(workspaces).where(eq(workspaces.id, removable)),
    ).toHaveLength(0);
  });

  it("serializes repeatable-read owner removals through the guard version", async () => {
    const { admin } = await readyApp();
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    const workspaceId = await directSharedWorkspace([admin.id, second.id], "Repeatable Team");

    let ready = 0;
    let open!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      open = resolve;
    });
    const removeAs = (humanId: string) =>
      database.sql.begin("isolation level repeatable read", async (tx) => {
        // Establish each transaction's snapshot before either one writes.
        await tx`select count(*) from workspace_memberships where workspace_id = ${workspaceId}`;
        ready += 1;
        if (ready === 2) open();
        await bothReady;
        await tx`delete from workspace_memberships where workspace_id = ${workspaceId} and human_id = ${humanId}`;
      });

    const results = await Promise.allSettled([removeAs(admin.id), removeAs(second.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    if (loser?.status !== "rejected") throw new Error("expected one stale writer to fail");
    expect(rootCause(loser.reason)?.message ?? String(loser.reason)).toContain(
      "could not serialize access",
    );
    const owners = await database.db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.isOwner, true),
        ),
      );
    expect(owners).toHaveLength(1);
  });

  it("refuses truncating ownership tables and leaves every shared workspace owned", async () => {
    const { admin } = await readyApp();
    const workspaceId = await directSharedWorkspace([admin.id], "Truncate Guard");

    expect(await rejection(database.sql`truncate workspace_memberships`)).toContain(
      "cannot be truncated",
    );
    expect(await rejection(database.sql`truncate workspaces cascade`)).toContain(
      "cannot be truncated",
    );
    const owners = await database.db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.isOwner, true),
        ),
      );
    expect(owners).toHaveLength(1);
  });

  it("keeps one lock order when a service removal meets a direct membership write", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const [member] = await insertHuman({ email: "mixed.member@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: member.id,
      isOwner: false,
    });

    const release = createGate();
    let deleted!: () => void;
    const hasDeleted = new Promise<void>((resolve) => {
      deleted = resolve;
    });
    const holder = database.sql.begin(async (tx) => {
      await tx`
        delete from workspace_memberships
        where workspace_id = ${workspace.id} and human_id = ${member.id}
      `;
      deleted();
      await release.opened;
    });

    await hasDeleted;
    const removal = deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${member.id}`,
      adminCookie,
    );
    try {
      await waitForLockWait("lock_workspace_ownership_writes");
    } finally {
      release.release();
    }
    await holder;

    const res = await removal;
    expect(res.status).toBe(404);
    expect(await problemBody(res)).toMatchObject({ code: "member_not_found" });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, member.id)),
    ).toHaveLength(0);
  });

  it("lets an ownership writer finish before a competing direct delete takes the member row", async () => {
    const { admin } = await readyApp();
    const [member] = await insertHuman({ email: "waiting.member@example.com", verified: true });
    const workspaceId = await directSharedWorkspace([admin.id], "Write Order");
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: member.id,
      isOwner: false,
    });

    const release = createGate();
    const acquired = createGate();
    const holder = database.sql.begin(async (tx) => {
      await tx`select lock_workspace_ownership_writes()`;
      acquired.release();
      await release.opened;
      return tx`delete from workspace_memberships where workspace_id = ${workspaceId} and human_id = ${member.id} returning human_id`;
    });
    await acquired.opened;
    const competing =
      database.sql`delete from workspace_memberships where workspace_id = ${workspaceId} and human_id = ${member.id} returning human_id`.execute();
    try {
      await waitForLockWait("delete from workspace_memberships");
    } finally {
      release.release();
      const results = await Promise.all([holder, competing]);
      expect(results[0]).toMatchObject([{ human_id: member.id }]);
      expect(results[1]).toHaveLength(0);
    }
  });

  it("locks both guards in id order for opposite cross-workspace membership moves", async () => {
    const { admin } = await readyApp();
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    const [third] = await insertHuman({ email: "third.member@example.com", verified: true });
    const [fourth] = await insertHuman({ email: "fourth.member@example.com", verified: true });
    const workspaceA = await directSharedWorkspace([admin.id], "Order A");
    const workspaceB = await directSharedWorkspace([second.id], "Order B");
    const fromA = randomUUID();
    const fromB = randomUUID();
    await database.db.insert(workspaceMemberships).values([
      { id: fromA, workspaceId: workspaceA, humanId: third.id, isOwner: false },
      { id: fromB, workspaceId: workspaceB, humanId: fourth.id, isOwner: false },
    ]);

    await Promise.all([
      database.db
        .update(workspaceMemberships)
        .set({ workspaceId: workspaceB })
        .where(eq(workspaceMemberships.id, fromA)),
      database.db
        .update(workspaceMemberships)
        .set({ workspaceId: workspaceA })
        .where(eq(workspaceMemberships.id, fromB)),
    ]);

    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.id, fromA)),
    ).toMatchObject([{ workspaceId: workspaceB }]);
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.id, fromB)),
    ).toMatchObject([{ workspaceId: workspaceA }]);
    for (const workspaceId of [workspaceA, workspaceB]) {
      const owners = await database.db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.isOwner, true),
          ),
        );
      expect(owners).toHaveLength(1);
    }
  });

  it.each(["workspace_ownership_guards", "workspace_invitations"] as const)(
    "refuses redemption when a lock on %s outlasts the deadline",
    async (table) => {
      const { app, sent, adminCookie } = await readyApp();
      const workspace = await createWorkspace(app, adminCookie);
      const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
      await invite(app, adminCookie, workspace.id, INVITEE);
      const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
      await database.db
        .update(workspaceInvitations)
        .set({ expiresAt: sql`statement_timestamp() + interval '1 second'` })
        .where(eq(workspaceInvitations.workspaceId, workspace.id));

      const release = createGate();
      let locked!: () => void;
      const hasLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = database.sql.begin(async (tx) => {
        await tx`
        select workspace_id
        from ${tx(table)}
        where workspace_id = ${workspace.id}
        for update
      `;
        locked();
        await release.opened;
      });

      await hasLocked;
      const acceptance = postJson(
        app,
        "/api/workspace-invitations/acceptance",
        { token },
        memberCookie,
      );
      let timedOut: unknown;
      try {
        await waitForLockWait(table);
        const [waiting] = await database.sql<{ query_start: string }[]>`
        select query_start
        from pg_stat_activity
        where wait_event_type = 'Lock'
          and query ilike ${`%${table}%`}
          and pid <> pg_backend_pid()
        order by query_start
        limit 1
      `;
        const [invitation] = await database.db
          .select({ expiresAt: workspaceInvitations.expiresAt })
          .from(workspaceInvitations)
          .where(eq(workspaceInvitations.workspaceId, workspace.id));
        if (waiting === undefined || invitation === undefined) {
          throw new Error("the blocked redemption or its invitation was not found");
        }
        // The request had started before the deadline, then waited on the guard.
        expect(new Date(waiting.query_start).getTime()).toBeLessThan(
          invitation.expiresAt.getTime(),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      } catch (error) {
        timedOut = error;
      } finally {
        release.release();
      }
      await holder;
      const refused = await acceptance;
      if (timedOut !== undefined) throw timedOut;

      expect(refused.status).toBe(400);
      expect(await problemBody(refused)).toMatchObject({ code: "invitation_invalid" });
      expect(
        await database.db
          .select()
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, workspace.id)),
      ).toHaveLength(1); // the creator only
    },
  );
});
