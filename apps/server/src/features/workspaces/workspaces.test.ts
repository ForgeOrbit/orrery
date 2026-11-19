import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { WorkspacesResponse } from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccountsFeature } from "../accounts/index.ts";
import { createInvitationsFeature } from "../invitations/index.ts";
import { createSettingsFeature } from "../settings/index.ts";
import { browserSessions, humans, workspaces } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createWorkspacesFeature } from "./index.ts";

// Runs against a real Postgres (see AGENTS.md): what a listing contains is decided by
// the same queries production runs. The privacy boundary is the point of this feature's
// read side: another person's personal workspace never appears, not even for a system
// administrator.

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const INVITEE_INPUT = "  Member@Example.COM ";
const INVITEE = "member@example.com";
const INVITEE_PASSWORD = "invited-person-password";

const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

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

// The invited person's registration, driven through the API like the real flow.
async function registerInvited(app: Hono, sent: { to: string; text: string }[]) {
  const adminCookie = await cookieFor(app, EMAIL, PASSWORD);
  // SMTP configured first, because the invitation travels by email.
  const saved = await app.request("/api/settings/smtp", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      host: "smtp.example.test",
      port: 587,
      security: "starttls",
      username: null,
      password: null,
      from: "orrery@example.test",
    }),
  });
  expect(saved.status).toBe(200);
  const invited = await postJson(
    app,
    "/api/invitations/installation",
    { email: INVITEE_INPUT },
    adminCookie,
  );
  expect(invited.status).toBe(201);
  const token = sent[0]?.text.match(/\/register\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error("the invitation email carried no token");
  const res = await postJson(app, "/api/invitations/installation/registration", {
    token,
    password: INVITEE_PASSWORD,
  });
  expect(res.status).toBe(200);
  return cookieFor(app, INVITEE, INVITEE_PASSWORD);
}

// One person's workspace listing.
async function listing(app: Hono, cookie?: string) {
  const res = await app.request("/api/workspaces", cookie ? { headers: { cookie } } : undefined);
  return { status: res.status, body: res.json() };
}

describe("workspaces", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  afterEach(async () => {
    await database.db.execute(
      sql`truncate invitations, humans, workspaces, browser_sessions, instance_setup, instance_settings, email_verification_tokens`,
    );
  });

  // Wired like features/index.ts, with a fake transport that keeps the emails, so the
  // invitation token can be read back the way a recipient would.
  function makeApp() {
    const sent: { to: string; text: string }[] = [];
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
        sent.push({ to: mail.to, text: mail.text });
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
      sessionReader: accounts.sessionReader,
    });
    const app = createApp({
      features: [accounts, settings, invitationsFeature, workspacesFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    return { app, sent };
  }

  it("refuses the listing without a signed-in account", async () => {
    const { app } = makeApp();
    await bootstrapAdmin(app);
    const res = await app.request("/api/workspaces");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 401, code: "not_signed_in" });
  });

  it("lists the administrator's own personal workspace", async () => {
    const { app } = makeApp();
    await bootstrapAdmin(app);
    const { status, body } = await listing(app, await cookieFor(app, EMAIL, PASSWORD));
    expect(status).toBe(200);
    const own = WorkspacesResponse.parse(await body);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ kind: "personal", name: "Personal" });
  });

  it("lists the invited person's personal workspace, and nobody else's", async () => {
    const { app, sent } = makeApp();
    await bootstrapAdmin(app);
    const invitedCookie = await registerInvited(app, sent);

    // The invited person sees exactly their own workspace.
    const invitedListing = await listing(app, invitedCookie);
    expect(invitedListing.status).toBe(200);
    const own = WorkspacesResponse.parse(await invitedListing.body);
    expect(own).toHaveLength(1);
    const [human] = await database.db.select().from(humans).where(eq(humans.email, INVITEE));
    const [workspace] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, human?.id ?? ""));
    expect(own[0]?.id).toBe(workspace?.id);
    expect(own[0]).toMatchObject({ kind: "personal" });

    // The system administrator — another person with the most authority the
    // installation has — sees only their own, never the invited person's.
    const adminListing = await listing(app, await cookieFor(app, EMAIL, PASSWORD));
    expect(adminListing.status).toBe(200);
    const admins = WorkspacesResponse.parse(await adminListing.body);
    expect(admins).toHaveLength(1);
    expect(admins[0]?.id).not.toBe(own[0]?.id);
    expect(admins.map((w) => w.id)).not.toContain(own[0]?.id);
  });

  it("answers an empty listing for an account without a workspace", async () => {
    const { app } = makeApp();
    await bootstrapAdmin(app);
    const [account] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email: "bare@example.com", passwordHash: "scrypt$anything" })
      .returning();
    if (account === undefined) throw new Error("the bare account was not created");
    const token = randomBytes(32).toString("base64url");
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: account.id,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });

    const { status, body } = await listing(app, `orrery_session=${token}`);
    expect(status).toBe(200);
    expect(await body).toEqual([]);
  });
});
