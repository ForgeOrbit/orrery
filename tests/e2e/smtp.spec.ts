// The SMTP story (issue #22), through the API: the administrator saves SMTP settings,
// sends the test email to their own address, the Mailpit catcher receives it, and its
// verification token is redeemed by POST. A broken relay answers with an actionable
// Problem and never blocks sign-in or repair, and a restart keeps everything.
// Black-box: HTTP against a running Orrery, never server code; no browser needed, the
// API proof is the point.
//
// Runs after bootstrap.spec.ts (alphabetical file order, one worker), which created the
// administrator and closed setup. Errors answer as RFC 9457 Problems (ADR-0003).
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const exec = promisify(execCallback);

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

// The Mailpit catcher the mail-test compose profile starts (compose.yaml). Its API is
// how this suite proves actual delivery. Override when the catcher listens elsewhere.
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const restartCommand = process.env.ORRERY_RESTART_CMD;

// A password the stack stores encrypted at rest (ADR-0004); its plaintext is a needle.
const SMTP_PASSWORD = "catcher-relay-passphrase-for-tests";

// The settings that deliver through the catcher: its SMTP listener is plain and open,
// reached over the compose network.
const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;
// A password-bearing shape for the echo check: security tls is allowed to carry one
// (only "none" refuses credentials), and it is never sent anywhere.
const SETTINGS_WITH_PASSWORD = {
  host: "mailpit",
  port: 465,
  security: "tls",
  username: "postmaster",
  password: SMTP_PASSWORD,
  from: "orrery@orrery.test",
} as const;
const SUBJECT = "Verify your Orrery email";

// The fresh token from the last delivered test email; test 3 fills this in, test 4
// redeems it. Tests run in file order.
let verificationToken = "";

let api: APIRequestContext;
test.beforeAll(async () => {
  // The plaintext and the deployment's key are both secrets the stack's logs must never
  // contain (ADR-0004).
  await recordSecret(SMTP_PASSWORD);
  const encryptionKey = process.env.ORRERY_ENCRYPTION_KEY;
  if (encryptionKey !== undefined) await recordSecret(encryptionKey);
  api = await request.newContext({ baseURL: baseUrl });
  // Sign in here, not inside a test: Playwright restarts the worker after a failed
  // test, and a restarted worker re-runs this hook with a fresh, signed-in context —
  // every test below stays authorized whatever happened to its predecessors.
  const res = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.status()).toBe(200);
});
test.afterAll(async () => {
  await api?.dispose();
});

test("refuses every settings operation without a session", async () => {
  // A throwaway context: no cookie, guaranteed, whatever the shared one holds.
  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const attempts = [
      await anonymous.get("/api/settings/smtp"),
      await anonymous.put("/api/settings/smtp", { data: SETTINGS }),
      await anonymous.post("/api/settings/smtp/test"),
      await anonymous.post("/api/settings/email-verification", { data: { token: "x" } }),
    ];
    for (const res of attempts) {
      expect(res.status()).toBe(401);
      expect(res.headers()["content-type"]).toBe("application/problem+json");
      expect(await res.json()).toMatchObject({ status: 401, code: "not_signed_in" });
    }
  } finally {
    await anonymous.dispose();
  }
});

test("saves the SMTP settings without ever echoing the password", async () => {
  // First a password-bearing shape: the stack stores it encrypted at rest with the
  // deployment's key (ADR-0004) and returns only that one is stored.
  const withPassword = await api.put("/api/settings/smtp", {
    data: SETTINGS_WITH_PASSWORD,
  });
  expect(withPassword.status()).toBe(200);
  const stored = await withPassword.json();
  expect(stored).toMatchObject({ security: "tls", username: "postmaster", hasPassword: true });
  // The plaintext is never echoed, in any response.
  expect(JSON.stringify(stored)).not.toContain(SMTP_PASSWORD);

  // Then the settings that actually deliver through the catcher: its listener is
  // plain and open, so security none with no credentials.
  const saved = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);
  const body = await saved.json();
  expect(body).toEqual({
    host: "mailpit",
    port: 1025,
    security: "none",
    username: null,
    hasPassword: false,
    from: "orrery@orrery.test",
  });

  const got = await api.get("/api/settings/smtp");
  expect(await got.json()).toEqual(body);
});

test("sends the test email, and the catcher receives it with a fresh token", async () => {
  const res = await api.post("/api/settings/smtp/test");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ sentTo: ADMIN_EMAIL });

  // Actual delivery: the catcher holds the message, addressed to the administrator.
  let messageId: string | undefined;
  await expect
    .poll(
      async () => {
        const list = await api.get(`${mailpit}/api/v1/messages`);
        messageId = await caughtMessageId(list);
        return messageId !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  if (messageId === undefined) throw new Error("the catcher never received the email");

  const detail = await api.get(`${mailpit}/api/v1/message/${messageId}`);
  const { text, to } = caughtTextAndTo(await detail.json());
  expect(text).toContain(ADMIN_EMAIL);
  expect(to).toContain(ADMIN_EMAIL);
  // The email says how to complete verification, with no link to follow (issue #22
  // review): the token travels as its own identifiable line.
  expect(text).toContain("/api/settings/email-verification");
  expect(text).not.toContain("verify-email?token=");
  const token = text.match(/Single-use token, valid for 24 hours:\r?\n\r?\n([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // A token the stack's logs must never contain.
  await recordSecret(token ?? "");
  verificationToken = token ?? "";
});

test("completes email verification by POSTing the token, exactly once", async () => {
  const before = await api.get("/api/auth/session");
  expect(await before.json()).toEqual({
    email: ADMIN_EMAIL,
    displayName: null,
    emailVerified: false,
  });

  const res = await api.post("/api/settings/email-verification", {
    data: { token: verificationToken },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ email: ADMIN_EMAIL, emailVerified: true });

  const after = await api.get("/api/auth/session");
  expect(await after.json()).toEqual({
    email: ADMIN_EMAIL,
    displayName: null,
    emailVerified: true,
  });

  // Single-use: the same token is worthless once redeemed.
  const again = await api.post("/api/settings/email-verification", {
    data: { token: verificationToken },
  });
  expect(again.status()).toBe(400);
  expect(await again.json()).toMatchObject({ code: "verification_token_invalid" });
});

test("answers a broken relay with an actionable Problem, and keeps sign-in working", async () => {
  // A port nothing listens on, inside the stack's network.
  const broken = await api.put("/api/settings/smtp", {
    data: { ...SETTINGS, port: 9265 },
  });
  expect(broken.status()).toBe(200);

  const send = await api.post("/api/settings/smtp/test");
  expect(send.status()).toBe(502);
  expect(send.headers()["content-type"]).toBe("application/problem+json");
  expect(await send.json()).toMatchObject({ status: 502, code: "smtp_unreachable" });

  // The SMTP failure never touched the account: signing in still works...
  const relogin = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(relogin.status()).toBe(200);

  // ...and the settings are repairable, after which delivery works again.
  const repaired = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(repaired.status()).toBe(200);
  const sendAgain = await api.post("/api/settings/smtp/test");
  expect(sendAgain.status()).toBe(200);
});

test("keeps the settings and the verified email across a restart", async () => {
  test.skip(
    !restartCommand,
    "Set ORRERY_RESTART_CMD to a command that restarts the server, for example " +
      "'docker compose -f <repo>/compose.yaml restart orrery'.",
  );

  // The skip above guarantees a command is present; the empty string is unreachable.
  await exec(restartCommand ?? "", { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        try {
          return (await api.get("/readyz")).ok();
        } catch {
          // The server is still coming back; the poll tries again.
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();

  const got = await api.get("/api/settings/smtp");
  expect(await got.json()).toMatchObject({
    host: "mailpit",
    port: 1025,
    security: "none",
    hasPassword: false,
    from: "orrery@orrery.test",
  });

  // The verified email survived the restart too.
  const session = await api.get("/api/auth/session");
  expect(session.status()).toBe(200);
  expect(await session.json()).toEqual({
    email: ADMIN_EMAIL,
    displayName: null,
    emailVerified: true,
  });

  // And the settings still deliver.
  const send = await api.post("/api/settings/smtp/test");
  expect(send.status()).toBe(200);
});

// The catcher's list of messages, scanned for the verification email: its ID, or
// undefined while nothing has arrived yet. Fields are read with runtime checks, never
// type assertions — a third party's response is not trusted to match a cast.
async function caughtMessageId(res: APIResponse) {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== SUBJECT) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id === "string") return id;
  }
  return undefined;
}

// The text body and recipient addresses of one caught message.
function caughtTextAndTo(detail: unknown): { text: string; to: string[] } {
  if (typeof detail !== "object" || detail === null) throw new Error("no message detail");
  const text: unknown = Reflect.get(detail, "Text");
  const to: unknown = Reflect.get(detail, "To");
  if (typeof text !== "string") throw new Error("the caught message has no text body");
  if (!Array.isArray(to)) throw new Error("the caught message has no recipients");
  const addresses = to.flatMap((entry): string[] => {
    const address: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "Address") : undefined;
    return typeof address === "string" ? [address] : [];
  });
  return { text, to: addresses };
}
