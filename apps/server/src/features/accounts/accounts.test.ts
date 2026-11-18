import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Problem } from "@orrery/contract";
import type { Hono } from "hono";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { browserSessions, humans, instanceSetup, workspaces } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import type { Logger } from "../../platform/log.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { AccountsError, createAccountsService } from "./service.ts";
import { createAccountsFeature } from "./index.ts";

// Runs against a real Postgres: bootstrap races, sessions, and migrations must never be
// tested against mocks (see AGENTS.md). The secret obeys the 32-character minimum.
const SECRET = "correct horse battery staple staple";
const EMAIL_INPUT = "  Admin@Example.COM "; // One normalization: trim, then lowercase.
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";

// The request log goes to the console; tests that don't capture it stay quiet.
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("orrery_session="));

const problemBody = async (res: Response) => Problem.parse(await res.json());

// Drizzle wraps the driver's error; the root's message (the PostgresError's) names the
// violated constraint. Resolves with that message, or the stringified error.
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
}

describe("accounts", () => {
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
    await database.db.execute(sql`truncate humans, workspaces, browser_sessions, instance_setup`);
  });

  function makeApp(
    setupSecret: string | undefined,
    log: Logger = silentLogger,
    publicUrl = PUBLIC_URL,
  ) {
    return createApp({
      features: [createAccountsFeature({ db: database.db, setupSecret, publicUrl })],
      publicUrl,
      log,
    });
  }

  const setupBody = { secret: SECRET, email: EMAIL_INPUT, password: PASSWORD };

  async function bootstrapAdmin(app: Hono) {
    const res = await postJson(app, "/api/setup/admin", setupBody);
    expect(res.status).toBe(201);
  }

  describe("initial setup", () => {
    it("reports setup as incomplete and changes nothing on GETs", async () => {
      const app = makeApp(SECRET);
      const status = await app.request("/api/setup/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ setupComplete: false });

      // Visiting (GET) creates no accounts, workspaces, sessions, or setup state.
      await app.request("/api/auth/session");
      await app.request("/api/setup/status");
      expect(await database.db.select().from(humans)).toHaveLength(0);
      expect(await database.db.select().from(instanceSetup)).toHaveLength(0);
    });

    it("refuses setup when no deployment secret is configured", async () => {
      const app = makeApp(undefined);
      const res = await postJson(app, "/api/setup/admin", setupBody);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        message:
          "Initial setup is not available. Set BOOTSTRAP_SECRET in the server's environment.",
      });
      expect(await database.db.select().from(humans)).toHaveLength(0);
      expect(await database.db.select().from(instanceSetup)).toHaveLength(0);
    });

    it("refuses an invalid secret without closing setup", async () => {
      const app = makeApp(SECRET);
      const res = await postJson(app, "/api/setup/admin", {
        ...setupBody,
        secret: "not the secret",
      });
      expect(res.status).toBe(401);
      const body = await problemBody(res);
      expect(body.message).toBe("Invalid setup secret.");
      expect(body.message).not.toContain(PASSWORD);

      const status = await app.request("/api/setup/status");
      expect(await status.json()).toEqual({ setupComplete: false });
      expect(await database.db.select().from(humans)).toHaveLength(0);
    });

    it("refuses an invalid request body", async () => {
      const app = makeApp(SECRET);
      for (const body of [
        { ...setupBody, secret: "" },
        { ...setupBody, password: "short" },
        { ...setupBody, email: "not-an-email" },
      ]) {
        const res = await postJson(app, "/api/setup/admin", body);
        expect(res.status).toBe(400);
      }
      expect(await database.db.select().from(humans)).toHaveLength(0);
    });

    it("creates the administrator, its personal workspace, and closes setup in one transaction", async () => {
      const app = makeApp(SECRET);
      const res = await postJson(app, "/api/setup/admin", setupBody);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ email: EMAIL });

      const [admin] = await database.db.select().from(humans);
      expect(admin).toMatchObject({
        email: EMAIL,
        isSystemAdministrator: true,
        emailVerifiedAt: null, // SMTP is not required; the address stays unverified.
      });
      expect(admin?.passwordHash).toMatch(/^scrypt\$/);
      expect(admin?.passwordHash).not.toContain(PASSWORD);

      const [workspace] = await database.db.select().from(workspaces);
      expect(workspace).toMatchObject({ kind: "personal", personalOwnerHumanId: admin?.id });

      const [setup] = await database.db.select().from(instanceSetup);
      expect(setup).toMatchObject({ id: true, administratorHumanId: admin?.id });

      const status = await app.request("/api/setup/status");
      expect(await status.json()).toEqual({ setupComplete: true });
    });

    it("refuses a second setup attempt, even with the correct secret", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const res = await postJson(app, "/api/setup/admin", {
        ...setupBody,
        email: "other@example.com",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ message: "Initial setup is already complete." });
      expect(await database.db.select().from(humans)).toHaveLength(1);
    });

    it("settles two concurrent setup attempts with exactly one winner", async () => {
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const results = await Promise.allSettled([
        service.setupAdmin({ secret: SECRET, email: "a@example.com", password: PASSWORD }),
        service.setupAdmin({ secret: SECRET, email: "b@example.com", password: PASSWORD }),
      ]);

      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners).toHaveLength(1);
      expect(winners[0]?.value.email).toMatch(/^[ab]@example\.com$/);

      const loser = results.find((r) => r.status === "rejected");
      if (loser?.status !== "rejected") throw new Error("expected one rejected attempt");
      expect(loser.reason).toBeInstanceOf(AccountsError);
      expect(loser.reason.kind).toBe("setup_complete");

      // The loser's human and workspace rolled back with its claim on the singleton.
      expect(await database.db.select().from(humans)).toHaveLength(1);
      expect(await database.db.select().from(workspaces)).toHaveLength(1);
      expect(await database.db.select().from(instanceSetup)).toHaveLength(1);
    });

    it("settles two concurrent same-email attempts with one winner, and the loser learns setup is complete", async () => {
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const results = await Promise.allSettled([
        service.setupAdmin({ secret: SECRET, email: "race@example.com", password: PASSWORD }),
        service.setupAdmin({ secret: SECRET, email: "race@example.com", password: PASSWORD }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected");
      if (loser?.status !== "rejected") throw new Error("expected one rejected attempt");
      // The winner closed setup, so the honest answer to the loser is that setup is
      // complete — not a misleading "email is taken" for a race it can never win.
      expect(loser.reason).toBeInstanceOf(AccountsError);
      expect(loser.reason.kind).toBe("setup_complete");
      expect(await database.db.select().from(humans)).toHaveLength(1);
    });
  });

  describe("database constraints", () => {
    it("rejects a human whose email is not normalized", async () => {
      const message = await rejectionMessage(
        database.db.insert(humans).values({
          id: randomUUID(),
          email: "Mixed@Example.com",
          passwordHash: "scrypt$anything",
        }),
      );
      expect(message).toContain("humans_email_normalized");
    });

    it("rejects a workspace kind outside the contract enum", async () => {
      // The Drizzle typing prevents an invalid kind in code; the CHECK is the guard for
      // every other writer, so bypass the typing with raw SQL here.
      const message = await rejectionMessage(
        database.db.execute(
          sql`insert into workspaces (id, kind, name) values (${randomUUID()}, 'team', 'Nope')`,
        ),
      );
      expect(message).toContain("workspace_kind");
    });

    it("rejects a personal workspace without an owner, and a shared one with an owner", async () => {
      const missingOwner = await rejectionMessage(
        database.db.insert(workspaces).values({ id: randomUUID(), kind: "personal", name: "Nope" }),
      );
      expect(missingOwner).toContain("workspace_owner_matches_kind");

      const [owner] = await database.db
        .insert(humans)
        .values({ id: randomUUID(), email: "owner@example.com", passwordHash: "scrypt$anything" })
        .returning();
      const sharedWithOwner = await rejectionMessage(
        database.db.insert(workspaces).values({
          id: randomUUID(),
          kind: "shared",
          name: "Nope",
          personalOwnerHumanId: owner?.id,
        }),
      );
      expect(sharedWithOwner).toContain("workspace_owner_matches_kind");
    });
  });

  describe("sign-in", () => {
    it("signs in, sets a secure cookie, and answers the session check", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      const res = await postJson(app, "/api/auth/login", {
        email: EMAIL_INPUT,
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ email: EMAIL });

      const cookie = sessionCookie(res);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=604800"); // Seven days.
      expect(cookie).not.toContain("Secure"); // This app's PUBLIC_URL is http.

      const withSession = await app.request("/api/auth/session", {
        headers: { cookie: cookie?.split(";")[0] },
      });
      expect(withSession.status).toBe(200);
      expect(await withSession.json()).toEqual({ email: EMAIL });

      const noSession = await app.request("/api/auth/session");
      expect(noSession.status).toBe(401);

      const garbage = await app.request("/api/auth/session", {
        headers: { cookie: "orrery_session=not-a-real-token" },
      });
      expect(garbage.status).toBe(401);
      expect(await database.db.select().from(browserSessions)).toHaveLength(1);
    });

    it("marks the cookie Secure when the public URL is https", async () => {
      const app = makeApp(SECRET, undefined, "https://orrery.test");
      await bootstrapAdmin(app);
      const res = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      expect(sessionCookie(res)).toContain("Secure");
    });

    it("answers a wrong password and an unknown email identically", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      const wrongPassword = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: "not-the-password",
      });
      const unknownEmail = await postJson(app, "/api/auth/login", {
        email: "nobody@example.com",
        password: PASSWORD,
      });
      expect(wrongPassword.status).toBe(unknownEmail.status);
      expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("answers a short password like any other wrong password", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      // A stored password may predate today's rules; login accepts any non-empty
      // password and answers wrong ones with the same 401, whatever their shape.
      const short = await postJson(app, "/api/auth/login", { email: EMAIL, password: "tiny" });
      const wrong = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: "not-the-password",
      });
      expect(short.status).toBe(401);
      expect(await short.json()).toEqual(await wrong.json());
      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("answers a malformed email and overlong input like any other wrong credentials", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      const wrong = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: "not-the-password",
      });
      const expected = await problemBody(wrong);
      const attempts = [
        { email: "not-an-email", password: PASSWORD },
        { email: "x".repeat(2048), password: PASSWORD },
        { email: EMAIL, password: "x".repeat(2048) },
        { email: "  Nobody@Example.COM  ", password: "not-the-password" },
      ];
      for (const body of attempts) {
        const res = await postJson(app, "/api/auth/login", body);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(expected);
      }
      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("keeps setup closed and sign-in working for a fresh service instance over the same database", async () => {
      const first = makeApp(SECRET);
      await bootstrapAdmin(first);
      const login = await postJson(first, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      const cookie = sessionCookie(login)?.split(";")[0];

      // A new service instance holds no in-memory state: everything above lives in Postgres.
      const second = makeApp(SECRET);

      const setupAgain = await postJson(second, "/api/setup/admin", setupBody);
      expect(setupAgain.status).toBe(409);
      const status = await second.request("/api/setup/status");
      expect(await status.json()).toEqual({ setupComplete: true });

      const stillSignedIn = await second.request("/api/auth/session", { headers: { cookie } });
      expect(stillSignedIn.status).toBe(200);
      expect(await stillSignedIn.json()).toEqual({ email: EMAIL });

      const relogin = await postJson(second, "/api/auth/login", {
        email: EMAIL,
        password: PASSWORD,
      });
      expect(relogin.status).toBe(200);
    });
  });

  describe("logs", () => {
    it("records requests without the password, the secret, or the session token", async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
      try {
        const log = createLogger("info");
        const app = makeApp(SECRET, log);
        await bootstrapAdmin(app);
        const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
        const token = sessionCookie(login)?.split(";")[0]?.split("=")[1] ?? "";

        const captured = lines.join("\n");
        // The request log itself was captured, so the absence below is meaningful.
        expect(captured).toContain("/api/setup/admin");
        expect(captured).toContain("/api/auth/login");
        expect(captured).not.toContain(PASSWORD);
        expect(captured).not.toContain(SECRET);
        expect(captured).not.toContain(token);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
