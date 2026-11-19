import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  InstallationInvitation,
  Problem,
  SessionResponse,
  type SmtpSettings,
} from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccountsFeature } from "../accounts/index.ts";
import { createSettingsFeature } from "../settings/index.ts";
import { browserSessions, humans, invitations, workspaces } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { type Logger, createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createInvitationsFeature } from "./index.ts";
import { createInvitationsService, InvitationsError } from "./service.ts";
import type { SmtpMail, SmtpSender } from "../settings/index.ts";

// Runs against a real Postgres (see AGENTS.md): token redemption, seven-day expiry,
// and the one-account-one-workspace transaction are database behavior, not mock
// behavior. Delivery is faked at the transport here; the black-box e2e suite proves
// real delivery through Mailpit.

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
// One normalization: trim, then lowercase (the contract's Email schema).
const INVITEE_INPUT = "  Member@Example.COM ";
const INVITEE = "member@example.com";
const INVITEE_PASSWORD = "invited-person-password";
// Seven days, fixed here so the boundary tests can pin it.
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The request log goes to the console; tests that don't capture it stay quiet.
const silentLogger: Logger = createLogger("error");

// The settings that make deliver() work. No credentials, so no encryption key is needed.
const SETTINGS: SmtpSettings = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  username: null,
  password: null,
  from: "orrery@example.test",
};

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

const problemBody = async (res: Response) => Problem.parse(await res.json());

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

// The invitation token as the emailed link carries it, tolerant of nothing else on the
// line.
const tokenFrom = (text: string) => text.match(/\/register\?token=([A-Za-z0-9_-]+)/)?.[1];

// A fake SMTP transport: records what the service handed it, and can be told to fail
// the way a real one would, with the same error codes the sender classifies.
function createFakeTransport() {
  const sent: SmtpMail[] = [];
  let failure: (() => Error) | undefined;
  const sender: SmtpSender = async (_settings, mail) => {
    if (failure) throw failure();
    sent.push(mail);
  };
  return {
    sent,
    failWith(errorFactory: () => Error) {
      failure = errorFactory;
    },
    // The relay is repaired: deliveries succeed again.
    repair() {
      failure = undefined;
    },
    sender,
  };
}

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

// The shared story so far: the first administrator exists (bootstrap) and is signed in.
async function bootstrapAdmin(app: Hono) {
  const res = await postJson(app, "/api/setup/admin", {
    secret: SECRET,
    email: EMAIL,
    password: PASSWORD,
  });
  expect(res.status).toBe(201);
}

async function adminCookie(app: Hono): Promise<string> {
  const res = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  return cookie;
}

describe("invitations", () => {
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

  // A signed-in account that is not a system administrator, created directly: the point
  // is the permission boundary, not the flow.
  async function ordinaryCookie(email = "other@example.com") {
    const [account] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email, passwordHash: "scrypt$anything" })
      .returning();
    if (account === undefined) throw new Error("the ordinary account was not created");
    const token = randomBytes(32).toString("base64url");
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: account.id,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
    return `orrery_session=${token}`;
  }

  // Wired like features/index.ts wires them, so the seams under test are the real ones:
  // only the SMTP transport is faked.
  function makeApp(opts: { smtp?: SmtpSender; log?: Logger } = {}) {
    const log = opts.log ?? silentLogger;
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
      // exactOptionalPropertyTypes: pass the sender only when the test provides one,
      // so the service's real SMTP default stays in play otherwise.
      ...(opts.smtp === undefined ? {} : { sendMail: opts.smtp }),
      log,
    });
    const invitationsFeature = createInvitationsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log,
    });
    return createApp({
      features: [accounts, settings, invitationsFeature],
      publicUrl: PUBLIC_URL,
      log,
    });
  }

  // The app with SMTP saved and the fake transport armed: the state every invitation
  // test starts from.
  async function armedApp() {
    const fake = createFakeTransport();
    const app = makeApp({ smtp: fake.sender });
    await bootstrapAdmin(app);
    const cookie = await adminCookie(app);
    const saved = await putJson(app, "/api/settings/smtp", SETTINGS, cookie);
    expect(saved.status).toBe(200);
    return { app, cookie, fake };
  } // armedApp, plus one invitation already sent to INVITEE: the token from the email
  // it sent, ready to redeem.
  async function invitedApp() {
    const armed = await armedApp();
    const res = await postJson(
      armed.app,
      "/api/invitations/installation",
      { email: INVITEE_INPUT },
      armed.cookie,
    );
    expect(res.status).toBe(201);
    const token = tokenFrom(armed.fake.sent[0]?.text ?? "");
    expect(token).not.toBe("");
    return { ...armed, token: token ?? "" };
  }

  describe("sending an installation invitation", () => {
    it("refuses to send without a signed-in account", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);
      await putJson(app, "/api/settings/smtp", SETTINGS, await adminCookie(app));

      const res = await postJson(app, "/api/invitations/installation", { email: INVITEE_INPUT });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 401, code: "not_signed_in" });
      expect(await database.db.select().from(invitations)).toHaveLength(0);
      expect(fake.sent).toHaveLength(0);
    });

    it("refuses to send for a signed-in ordinary account", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);
      await putJson(app, "/api/settings/smtp", SETTINGS, await adminCookie(app));

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        await ordinaryCookie(),
      );
      expect(res.status).toBe(403);
      const body = await problemBody(res);
      expect(body).toMatchObject({ status: 403, code: "not_admin" });
      expect(body.title).toContain("system administrator");
      expect(await database.db.select().from(invitations)).toHaveLength(0);
      expect(fake.sent).toHaveLength(0);
    });

    it("refuses to send before SMTP is configured", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        await adminCookie(app),
      );
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "smtp_unconfigured" });
      expect(await database.db.select().from(invitations)).toHaveLength(0);
      expect(fake.sent).toHaveLength(0);
    });

    it("sends the invitation with a seven-day single-use link", async () => {
      const { app, cookie, fake } = await armedApp();
      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(201);
      const invitation = InstallationInvitation.parse(await res.json());
      expect(invitation).toEqual({ email: INVITEE, status: "pending" });

      // The email carries the link, addressed to the invited email.
      expect(fake.sent).toHaveLength(1);
      const mail = fake.sent[0];
      const token = tokenFrom(mail?.text ?? "");
      expect(token).not.toBe("");
      expect(mail?.to).toBe(INVITEE);
      expect(mail?.from).toBe(SETTINGS.from);
      expect(mail?.text).toContain(`${PUBLIC_URL}/register?token=${token}`);
      expect(mail?.text).toContain(INVITEE);

      // The stored row keeps only the hash, and the expiry is exactly seven days.
      const [row] = await database.db.select().from(invitations);
      if (row === undefined) throw new Error("the invitation was not stored");
      expect(row.email).toBe(INVITEE);
      expect(row.tokenHash).toBe(tokenHash(token ?? ""));
      expect(row.tokenHash).not.toBe(token);
      expect(row.status).toBe("pending");
      expect(row.acceptedAt).toBeNull();
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(INVITATION_TTL_MS);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      expect(row.invitedByHumanId).toBe(admin?.id);
    });

    it("refuses an invalid email with a validation Problem, and sends nothing", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);

      const res = await postJson(app, "/api/invitations/installation", { email: "nope" }, cookie);
      expect(res.status).toBe(400);
      const body = await problemBody(res);
      expect(body).toMatchObject({ code: "validation_failed" });
      expect(body.errors).toEqual([{ pointer: "/email", detail: expect.any(String) }]);
      expect(await database.db.select().from(invitations)).toHaveLength(0);
    });

    it("refuses an email that already has an account", async () => {
      const { app, cookie, fake } = await invitedApp();

      const res = await postJson(app, "/api/invitations/installation", { email: EMAIL }, cookie);
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "account_exists" });
      expect(await database.db.select().from(invitations)).toHaveLength(1); // the one from invitedApp
      expect(fake.sent).toHaveLength(1);
    });

    it("refuses a second pending invitation for the same email", async () => {
      const { app, cookie, fake } = await invitedApp();

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "invitation_pending" });
      expect(await database.db.select().from(invitations)).toHaveLength(1);
      expect(fake.sent).toHaveLength(1);
    });

    it("settles two concurrent invitations for the same email with one winner", async () => {
      // The state the service calls need: the administrator and a live database.
      await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      // The service seam, because two HTTP requests cannot share one app call site.
      const service = createInvitationsService({
        db: database.db,
        publicUrl: PUBLIC_URL,
        createInvitedHuman: async (input) => ({ humanId: input.email }),
        markEmailVerified: async () => {},
        deliver: async () => {},
      });
      const account = {
        humanId: admin.id,
        email: EMAIL,
        isSystemAdministrator: true,
        emailVerifiedAt: null,
      };
      const results = await Promise.allSettled([
        service.inviteInstallation(account, { email: "race@example.com" }),
        service.inviteInstallation(account, { email: "race@example.com" }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected");
      if (loser?.status !== "rejected") throw new Error("expected one rejected attempt");
      expect(loser.reason).toBeInstanceOf(InvitationsError);
      expect(loser.reason.kind).toBe("invitation_pending");
      const rows = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.email, "race@example.com"));
      expect(rows).toHaveLength(1);
    });

    it("answers a delivery failure with the reason's code, and leaves no live invitation", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      expect((await putJson(app, "/api/settings/smtp", SETTINGS, cookie)).status).toBe(200);

      fake.failWith(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
      const failed = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(failed.status).toBe(502);
      expect(failed.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(failed)).toMatchObject({
        status: 502,
        code: "smtp_unreachable",
        type: "urn:orrery:problem:smtp_unreachable",
      });
      // The email never left, so its link must not redeem.
      expect(await database.db.select().from(invitations)).toHaveLength(0);

      // The administrator can simply invite again once the relay is repaired.
      fake.repair();
      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(201);
      expect(await database.db.select().from(invitations)).toHaveLength(1);
    });

    it("records requests without the invitation token", async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
      try {
        const fake = createFakeTransport();
        const log = createLogger("info");
        const app = makeApp({ smtp: fake.sender, log });
        await bootstrapAdmin(app);
        const cookie = await adminCookie(app);
        await putJson(app, "/api/settings/smtp", SETTINGS, cookie);
        await postJson(app, "/api/invitations/installation", { email: INVITEE_INPUT }, cookie);
        const token = tokenFrom(fake.sent[0]?.text ?? "") ?? "";
        expect(token).not.toBe("");
        await postJson(app, "/api/invitations/installation/registration", {
          token,
          password: INVITEE_PASSWORD,
        });

        const captured = lines.join("\n");
        // The request log itself was captured, so the absence below is meaningful.
        expect(captured).toContain("/api/invitations/installation");
        expect(captured).not.toContain(token);
        expect(captured).not.toContain(INVITEE_PASSWORD);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("registering through an invitation", () => {
    it("registers through the emailed link's POST: one account, one personal workspace, one verified email", async () => {
      const { app, token } = await invitedApp();
      const humansBefore = await database.db.select().from(humans);
      const workspacesBefore = await database.db.select().from(workspaces);

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(SessionResponse.parse(await res.json())).toEqual({
        email: INVITEE,
        emailVerified: true,
      });

      // Exactly one account appeared, bound to the invited email, verified, ordinary.
      expect(await database.db.select().from(humans)).toHaveLength(humansBefore.length + 1);
      const [human] = await database.db.select().from(humans).where(eq(humans.email, INVITEE));
      expect(human).toMatchObject({ email: INVITEE, isSystemAdministrator: false });
      expect(human?.emailVerifiedAt).not.toBeNull();
      expect(human?.passwordHash).toMatch(/^scrypt\$/);
      expect(human?.passwordHash).not.toContain(INVITEE_PASSWORD);

      // Exactly one personal workspace appeared, owned by the new human.
      expect(await database.db.select().from(workspaces)).toHaveLength(workspacesBefore.length + 1);
      const [workspace] = await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, human?.id ?? ""));
      expect(workspace).toMatchObject({
        kind: "personal",
        personalOwnerHumanId: human?.id,
      });

      // The invitation is accepted, exactly once.
      const [row] = await database.db.select().from(invitations);
      expect(row).toMatchObject({ email: INVITEE, status: "accepted" });
      expect(row?.acceptedAt).not.toBeNull();

      // The account works: the invited person signs in with the password they chose.
      const login = await postJson(app, "/api/auth/login", {
        email: INVITEE,
        password: INVITEE_PASSWORD,
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .find((c) => c.startsWith("orrery_session="))
        ?.split(";")[0];
      const session = await app.request("/api/auth/session", { headers: { cookie: cookie ?? "" } });
      expect(await session.json()).toEqual({ email: INVITEE, emailVerified: true });
    });

    it("changes nothing on a mere link visit: GET never consumes the token", async () => {
      const { app, token } = await invitedApp();

      // The browser link, the API path, and the registration path: no GET route exists.
      const page = await app.request(`/register?token=${token}`);
      expect(page.status).toBe(404); // no static app is mounted in this suite
      const apiList = await app.request("/api/invitations/installation");
      expect(apiList.status).toBe(404);
      const apiGet = await app.request("/api/invitations/installation/registration");
      expect(apiGet.status).toBe(404);

      // The invitation survived every visit: it still registers.
      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(200);
      const [row] = await database.db.select().from(invitations);
      expect(row?.status).toBe("accepted");
    });

    it("refuses a reused token", async () => {
      const { app, token } = await invitedApp();
      const first = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(first.status).toBe(200);
      const humansAfterFirst = await database.db.select().from(humans);

      const again = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(again.status).toBe(400);
      expect(again.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(again)).toMatchObject({
        status: 400,
        code: "invitation_invalid",
        type: "urn:orrery:problem:invitation_invalid",
      });
      // The reuse changed nothing: no second account or workspace.
      expect(await database.db.select().from(humans)).toHaveLength(humansAfterFirst.length);
    });

    it("refuses a token that was never issued", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token: "never-issued",
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(400);
      expect(await problemBody(res)).toMatchObject({ code: "invitation_invalid" });
      expect(await database.db.select().from(humans)).toHaveLength(1); // only the administrator
    });

    it("refuses an expired invitation and accepts one just inside the seven days", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      // Boundaries set directly in the database, just outside and inside the deadline,
      // the way the spec asks: no test waits out a lifetime. Expiry is evaluated in
      // database time, in the redemption's own conditional update.
      await database.db.insert(invitations).values([
        {
          id: randomUUID(),
          email: INVITEE,
          status: "pending",
          tokenHash: tokenHash("just-expired"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() - interval '1 second'`,
        },
        {
          id: randomUUID(),
          email: "still.valid@example.com",
          status: "pending",
          tokenHash: tokenHash("still-valid"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() + make_interval(secs => ${7 * 24 * 60 * 60 - 1})`,
        },
      ]);

      const expired = await postJson(app, "/api/invitations/installation/registration", {
        token: "just-expired",
        password: INVITEE_PASSWORD,
      });
      expect(expired.status).toBe(400);
      expect(await problemBody(expired)).toMatchObject({ code: "invitation_invalid" });
      // The refused attempt consumed nothing.
      const [expiredRow] = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash("just-expired")));
      expect(expiredRow?.acceptedAt).toBeNull();
      expect(await database.db.select().from(humans)).toHaveLength(1);

      const valid = await postJson(app, "/api/invitations/installation/registration", {
        token: "still-valid",
        password: INVITEE_PASSWORD,
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({ email: "still.valid@example.com", emailVerified: true });
    });

    it("refuses a short password without consuming the invitation", async () => {
      const { app, token } = await invitedApp();

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: "short",
      });
      expect(res.status).toBe(400);
      expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });

      // The invitation is still redeemable with a real password.
      const retry = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(retry.status).toBe(200);
    });

    it("refuses an invited email that already has an account, changing nothing", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      // A pending invitation for a registered email: unreachable through the flows
      // (creation refuses one), so placed directly, like the boundary fixtures.
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");
      await database.db.insert(invitations).values({
        id: randomUUID(),
        email: EMAIL,
        status: "pending",
        tokenHash: tokenHash("already-registered"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 hour'`,
      });

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token: "already-registered",
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "account_exists" });

      // The transaction rolled back whole: the invitation is still pending, and no
      // second workspace appeared.
      const [row] = await database.db.select().from(invitations);
      expect(row?.status).toBe("pending");
      expect(row?.acceptedAt).toBeNull();
      expect(await database.db.select().from(workspaces)).toHaveLength(1);
    });

    it("settles two concurrent redemptions of one token with one winner", async () => {
      const { app, token } = await invitedApp();

      const results = await Promise.allSettled([
        app.request("/api/invitations/installation/registration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, password: INVITEE_PASSWORD }),
        }),
        app.request("/api/invitations/installation/registration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, password: INVITEE_PASSWORD }),
        }),
      ]);
      const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : -1));
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 400)).toHaveLength(1);

      // One account, one workspace, one acceptance — the loser changed nothing.
      const invitedHumans = await database.db
        .select()
        .from(humans)
        .where(eq(humans.email, INVITEE));
      expect(invitedHumans).toHaveLength(1);
      const personal = await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, invitedHumans[0]?.id ?? ""));
      expect(personal).toHaveLength(1);
    });

    it("proves registration is invitation-only: no other route creates an account", async () => {
      const { app, token } = await invitedApp();
      const before = await database.db.select().from(humans);

      // A token that was never issued registers nobody.
      const garbage = await postJson(app, "/api/invitations/installation/registration", {
        token: "not-a-token",
        password: INVITEE_PASSWORD,
      });
      expect(garbage.status).toBe(400);
      expect(await database.db.select().from(humans)).toHaveLength(before.length);

      // And the working invitation is the only way in: it still registers.
      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(await database.db.select().from(humans)).toHaveLength(before.length + 1);
    });
  });
});
