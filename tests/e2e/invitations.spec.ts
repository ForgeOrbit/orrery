// The invitation story (issue #23), through the API and the browser: the administrator
// sends an installation invitation, the Mailpit catcher receives the link, the link's
// GET is inert, the recipient's POST registers one account with one personal workspace,
// and reuse fails. Registration is invitation-only: there is no public sign-up.
// Black-box: HTTP and real pages against a running Orrery, never server code. Errors
// answer as RFC 9457 Problems (ADR-0003).
//
// Runs after bootstrap.spec.ts (alphabetical file order, one worker), which created the
// administrator and closed setup. SMTP is saved here, because this suite must deliver:
// the later smtp.spec.ts re-saves its own settings for its deeper story.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

// The Mailpit catcher the mail-test compose profile starts (compose.yaml).
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";

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
const SUBJECT = "Your Orrery invitation";

// Two invited people: one registers through the API, one through the browser. Their
// passwords and tokens are secrets the stack's logs must never contain.
const INVITEE_EMAIL = "newcomer@orrery.test";
const INVITEE_PASSWORD = "invited-newcomer-password";
const BROWSER_INVITEE_EMAIL = "browser.person@orrery.test";
const BROWSER_INVITEE_PASSWORD = "browser-checked-invitee-password";

// The fresh tokens from the last delivered invitation emails; the send tests fill
// these in, the later tests consume them. Tests run in file order.
let inviteeToken = "";
let browserInviteeToken = "";

let api: APIRequestContext;
test.beforeAll(async () => {
  for (const value of [INVITEE_PASSWORD, BROWSER_INVITEE_PASSWORD]) {
    await recordSecret(value);
  }
  api = await request.newContext({ baseURL: baseUrl });
  // Sign in as the administrator bootstrap.spec.ts created. Playwright restarts the
  // worker after a failed test, and a restarted worker re-runs this hook with a fresh,
  // signed-in context — every test below stays authorized whatever happened to its
  // predecessors.
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  // This suite must deliver: arm SMTP before anything sends.
  const saved = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);
});
test.afterAll(async () => {
  await api?.dispose();
});

test("refuses to send an invitation without a session", async () => {
  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const res = await anonymous.post("/api/invitations/installation", {
      data: { email: INVITEE_EMAIL },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()["content-type"]).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 401, code: "not_signed_in" });
  } finally {
    await anonymous.dispose();
  }
});

test("sends the invitation, and the catcher receives the seven-day link", async () => {
  const res = await api.post("/api/invitations/installation", { data: { email: INVITEE_EMAIL } });
  expect(res.status()).toBe(201);
  expect(await res.json()).toEqual({ email: INVITEE_EMAIL, status: "pending" });

  // Actual delivery: the catcher holds the invitation, addressed to the invitee.
  await expect
    .poll(async () => caughtInvitationToken(api, INVITEE_EMAIL), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtInvitationToken(api, INVITEE_EMAIL);
  if (token === undefined) throw new Error("the catcher never received the invitation");
  // A token the stack's logs must never contain.
  await recordSecret(token);
  inviteeToken = token;
});

test("refuses a registered email and a duplicate pending invitation", async () => {
  // The administrator's own address has an account.
  const registered = await api.post("/api/invitations/installation", {
    data: { email: ADMIN_EMAIL },
  });
  expect(registered.status()).toBe(409);
  expect(await registered.json()).toMatchObject({ status: 409, code: "account_exists" });

  // One pending invitation per email: the newcomer's link does not double.
  const duplicate = await api.post("/api/invitations/installation", {
    data: { email: INVITEE_EMAIL },
  });
  expect(duplicate.status()).toBe(409);
  expect(await duplicate.json()).toMatchObject({ status: 409, code: "invitation_pending" });
});

test("the link's GET is inert; the POST registers; reuse fails", async () => {
  expect(inviteeToken).not.toBe("");

  // Following the link serves the register page and changes nothing.
  const link = await api.get(`/register?token=${inviteeToken}`);
  expect(link.status()).toBe(200);
  expect(link.headers()["content-type"]).toContain("text/html");

  // No GET route redeems the token either: the unknown API GET falls through to the
  // app shell, never to an endpoint.
  const apiGet = await api.get("/api/invitations/installation/registration");
  expect(apiGet.status()).toBe(200);
  expect(apiGet.headers()["content-type"]).toContain("text/html");

  // The recipient's POST is what registers: one account, bound to the invited email,
  // starting verified.
  const res = await api.post("/api/invitations/installation/registration", {
    data: { token: inviteeToken, password: INVITEE_PASSWORD },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ email: INVITEE_EMAIL, emailVerified: true });

  // Single-use: the same token is worthless now.
  const again = await api.post("/api/invitations/installation/registration", {
    data: { token: inviteeToken, password: INVITEE_PASSWORD },
  });
  expect(again.status()).toBe(400);
  expect(await again.json()).toMatchObject({ code: "invitation_invalid" });

  // The account works: the invited person signs in with the password they chose.
  const login = await api.post("/api/auth/login", {
    data: { email: INVITEE_EMAIL, password: INVITEE_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const session = await api.get("/api/auth/session");
  expect(await session.json()).toMatchObject({ email: INVITEE_EMAIL, emailVerified: true });
});

test("registration is invitation-only: no public sign-up exists", async () => {
  // The plausible public-registration routes are not there.
  for (const path of ["/api/auth/register", "/api/register", "/api/auth/signup"]) {
    const res = await api.post(path, {
      data: { email: "x@example.com", password: "whatever-password" },
    });
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "not_found" });
  }

  // Without a real invitation, the only registration route refuses, and no account
  // appears: signing in with the attempted credentials is still impossible.
  const garbage = await api.post("/api/invitations/installation/registration", {
    data: { token: "not-a-real-token", password: "whatever-password" },
  });
  expect(garbage.status()).toBe(400);
  expect(await garbage.json()).toMatchObject({ code: "invitation_invalid" });
  const login = await api.post("/api/auth/login", {
    data: { email: "uninvited@orrery.test", password: "whatever-password" },
  });
  expect(login.status()).toBe(401);
});

test("accepting an invitation in the browser", async ({ page }) => {
  // A second invitation, for the person the browser will register.
  const invited = await api.post("/api/invitations/installation", {
    data: { email: BROWSER_INVITEE_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtInvitationToken(api, BROWSER_INVITEE_EMAIL), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtInvitationToken(api, BROWSER_INVITEE_EMAIL);
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);
  browserInviteeToken = token;

  // The emailed link, in the browser: a page, not a redemption.
  await page.goto(`/register?token=${browserInviteeToken}`);
  await expect(page.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();

  // Choosing a password is what registers: one flow, ending signed in.
  await page.getByLabel("Password").fill(BROWSER_INVITEE_PASSWORD);
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByText(`Signed in as ${BROWSER_INVITEE_EMAIL}.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem", { name: "Personal" })).toBeVisible();

  // The cookies the server just set are secrets the logs must never contain.
  for (const cookie of await page.context().cookies()) {
    await recordSecret(cookie.value);
  }
});

test("another person cannot access the new personal workspace", async ({ page }) => {
  expect(inviteeToken).not.toBe("");
  expect(browserInviteeToken).not.toBe("");

  // Over HTTP: each signed-in person sees exactly their own workspace, and nobody
  // else's — not even the system administrator's listing contains the invitees'.
  const newcomer = await request.newContext({ baseURL: baseUrl });
  const browserPerson = await request.newContext({ baseURL: baseUrl });
  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    for (const [context, email, password] of [
      [newcomer, INVITEE_EMAIL, INVITEE_PASSWORD],
      [browserPerson, BROWSER_INVITEE_EMAIL, BROWSER_INVITEE_PASSWORD],
    ] as const) {
      const login = await context.post("/api/auth/login", {
        data: { email, password },
      });
      expect(login.status()).toBe(200);
    }

    const newcomerList = await workspacesOf(newcomer);
    const browserPersonList = await workspacesOf(browserPerson);
    const adminList = await workspacesOf(api);

    expect(newcomerList).toHaveLength(1);
    expect(browserPersonList).toHaveLength(1);
    expect(adminList).toHaveLength(1);
    const [newcomerWorkspace] = newcomerList;
    const [browserWorkspace] = browserPersonList;
    const [adminWorkspace] = adminList;
    const ids = [newcomerWorkspace?.id, browserWorkspace?.id, adminWorkspace?.id];
    expect(new Set(ids).size).toBe(3);
    expect(adminList.map((w) => w.id)).not.toContain(newcomerWorkspace?.id);
    expect(adminList.map((w) => w.id)).not.toContain(browserWorkspace?.id);
    expect(browserPersonList.map((w) => w.id)).not.toContain(newcomerWorkspace?.id);
    expect(newcomerList.map((w) => w.id)).not.toContain(browserWorkspace?.id);

    // Without a session there is no listing at all.
    const refused = await anonymous.get("/api/workspaces");
    expect(refused.status()).toBe(401);
    expect(await refused.json()).toMatchObject({ status: 401, code: "not_signed_in" });
  } finally {
    await newcomer.dispose();
    await browserPerson.dispose();
    await anonymous.dispose();
  }

  // In the browser: the other person signs in and sees their own workspace, and no
  // trace of the first person's account or workspace.
  await page.goto("/signin");
  await page.getByLabel("Email").fill(INVITEE_EMAIL);
  await page.getByLabel("Password").fill(INVITEE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${INVITEE_EMAIL}.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  const content = await page.content();
  expect(content).not.toContain(BROWSER_INVITEE_EMAIL);
  for (const cookie of await page.context().cookies()) {
    await recordSecret(cookie.value);
  }
});

// One person's workspace listing, already validated against the response shape.
async function workspacesOf(context: APIRequestContext) {
  const res = await context.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the workspaces listing is not a list");
  return body.flatMap((workspace): { id: unknown }[] => {
    if (typeof workspace !== "object" || workspace === null) return [];
    const id: unknown = Reflect.get(workspace, "id");
    if (typeof id !== "string") return [];
    return [{ id }];
  });
}

// The invitation token for one recipient, from the catcher's copy of the email: scans
// the caught messages by subject and address. Fields are read with runtime checks,
// never type assertions — a third party's response is not trusted to match a cast.
async function caughtInvitationToken(
  client: APIRequestContext,
  to: string,
): Promise<string | undefined> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== SUBJECT) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text: unknown = Reflect.get(caught, "Text");
    if (typeof text !== "string") continue;
    if (!caughtRecipients(caught).includes(to)) continue;
    return text.match(/\/register\?token=([A-Za-z0-9_-]+)/)?.[1];
  }
  return undefined;
}

// The recipient addresses of one caught message.
function caughtRecipients(detail: object): string[] {
  const to: unknown = Reflect.get(detail, "To");
  if (!Array.isArray(to)) return [];
  return to.flatMap((entry): string[] => {
    const address: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "Address") : undefined;
    return typeof address === "string" ? [address] : [];
  });
}
