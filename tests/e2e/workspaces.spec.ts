// The shared-workspace story (issue #24), through the API and the browser: an owner
// creates a workspace, the last owner cannot remove themselves, an existing verified
// account accepts an invitation, a forwarded link is refused, and the browser shows the
// joined workspace as a separate view. Black-box: HTTP and real pages against a running
// Orrery, never server code.
//
// Runs after bootstrap.spec.ts and smtp.spec.ts (alphabetical file order, one worker),
// which created and verified the administrator. SMTP is saved here again so the suite
// delivers through the Mailpit catcher whatever earlier specs did.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;

const EXISTING_EMAIL = "workspace.existing@orrery.test";
const EXISTING_PASSWORD = "existing-workspace-password";
const NEW_EMAIL = "workspace.newcomer@orrery.test";
const NEW_PASSWORD = "new-workspace-password";

// Filled by the send test below; the browser test accepts the same invitation.
let invitationToken = "";
let invitationWorkspaceId = "";

let api: APIRequestContext;
test.beforeAll(async () => {
  for (const value of [EXISTING_PASSWORD, NEW_PASSWORD]) await recordSecret(value);
  api = await request.newContext({ baseURL: baseUrl });
  // Playwright restarts the worker after a failed test, and a restarted worker re-runs
  // this hook with a fresh, signed-in context.
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const saved = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);

  // The person the later workspace invitations target: an existing, verified account
  // created through the installation invitation flow.
  const invited = await api.post("/api/invitations/installation", {
    data: { email: EXISTING_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "installation"), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtToken(api, EXISTING_EMAIL, "installation");
  if (token === undefined)
    throw new Error("the catcher never received the installation invitation");
  await recordSecret(token);
  const registered = await api.post("/api/invitations/installation/registration", {
    data: { token, password: EXISTING_PASSWORD },
  });
  expect(registered.status()).toBe(200);
});
test.afterAll(async () => {
  await api?.dispose();
});

test("creates a shared workspace and refuses removing its last owner", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Solo Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();
  expect(workspace).toMatchObject({ kind: "shared", name: "Solo Team", isOwner: true });

  const members = await api.get(`/api/workspaces/${workspace.id}/members`);
  expect(members.status()).toBe(200);
  const body: unknown = await members.json();
  if (!Array.isArray(body)) throw new Error("the members listing is not a list");
  const admin = body.find((member) => {
    if (typeof member !== "object" || member === null) return false;
    return Reflect.get(member, "email") === ADMIN_EMAIL;
  });
  if (typeof admin !== "object" || admin === null)
    throw new Error("the administrator is not a member");
  const adminId: unknown = Reflect.get(admin, "humanId");
  if (typeof adminId !== "string") throw new Error("the administrator member has no id");

  const refused = await api.delete(`/api/workspaces/${workspace.id}/members/${adminId}`);
  expect(refused.status()).toBe(409);
  expect(refused.headers()["content-type"]).toBe("application/problem+json");
  expect(await refused.json()).toMatchObject({ status: 409, code: "last_owner" });

  const list = await api.get("/api/workspaces");
  expect(list.status()).toBe(200);
  const listBody: unknown = await list.json();
  if (!Array.isArray(listBody)) throw new Error("the workspaces listing is not a list");
  expect(listBody).toContainEqual(
    expect.objectContaining({ id: workspace.id, name: "Solo Team", isOwner: true }),
  );
});

test("invites an existing account, and a forwarded link is refused", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Rocket Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();
  invitationWorkspaceId = workspace.id;

  const sent = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: EXISTING_EMAIL },
  });
  expect(sent.status()).toBe(201);
  expect(await sent.json()).toEqual({
    workspaceId: workspace.id,
    email: EXISTING_EMAIL,
    status: "pending",
  });

  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Rocket Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const token = await caughtToken(api, EXISTING_EMAIL, "workspace", "Rocket Team");
  if (token === undefined) throw new Error("the catcher never received the workspace invitation");
  await recordSecret(token);
  invitationToken = token;

  // The link's read side shows the offer without consuming it.
  const preview = await api.get(`/api/workspace-invitations/preview?token=${token}`);
  expect(preview.status()).toBe(200);
  expect(await preview.json()).toMatchObject({
    workspaceId: workspace.id,
    workspaceName: "Rocket Team",
    email: EXISTING_EMAIL,
  });

  // Forwarded to the administrator's signed-in browser, the link cannot attach the
  // membership: only the invited, verified address may accept it.
  const forwarded = await api.post("/api/workspace-invitations/acceptance", {
    data: { token },
  });
  expect(forwarded.status()).toBe(403);
  expect(forwarded.headers()["content-type"]).toBe("application/problem+json");
  expect(await forwarded.json()).toMatchObject({
    status: 403,
    code: "invitation_recipient_mismatch",
  });

  // The refusal left the invitation live for its real recipient.
  const stillThere = await api.get(`/api/workspace-invitations/preview?token=${token}`);
  expect(stillThere.status()).toBe(200);
});

test("registers a new email into a workspace without a duplicate account", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Newcomer Lab" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  const sent = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: NEW_EMAIL },
  });
  expect(sent.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, NEW_EMAIL, "workspace", "Newcomer Lab"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const token = await caughtToken(api, NEW_EMAIL, "workspace", "Newcomer Lab");
  if (token === undefined) throw new Error("the catcher never received the workspace invitation");
  await recordSecret(token);

  const registered = await api.post("/api/workspace-invitations/registration", {
    data: { token, password: NEW_PASSWORD },
  });
  expect(registered.status()).toBe(200);
  expect(await registered.json()).toEqual({ email: NEW_EMAIL, emailVerified: true });

  // One account, verified, and a member of exactly the workspace that invited it.
  const newcomer = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await newcomer.post("/api/auth/login", {
      data: { email: NEW_EMAIL, password: NEW_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const workspaces = await newcomer.get("/api/workspaces");
    const body: unknown = await workspaces.json();
    if (!Array.isArray(body)) throw new Error("the workspaces listing is not a list");
    expect(body).toContainEqual(
      expect.objectContaining({ id: workspace.id, kind: "shared", isOwner: false }),
    );
  } finally {
    await newcomer.dispose();
  }
});

test("accepts a workspace invitation in the browser as the existing account", async ({ page }) => {
  expect(invitationToken).not.toBe("");
  expect(invitationWorkspaceId).not.toBe("");

  await page.goto("/signin");
  await page.getByLabel("Email").fill(EXISTING_EMAIL);
  await page.getByLabel("Password").fill(EXISTING_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${EXISTING_EMAIL}.`)).toBeVisible();

  await page.goto(`/workspace-invitation?token=${invitationToken}`);
  await expect(page.getByRole("heading", { name: "Join Rocket Team" })).toBeVisible();
  await expect(page.getByText(`You are signed in as ${EXISTING_EMAIL}.`)).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();

  // Acceptance leads into the workspace's own view, distinct from the personal one.
  await expect(page.getByRole("heading", { name: "Rocket Team" })).toBeVisible();
  await expect(page.getByText("Shared workspace · Member")).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  const joined = page.locator(`li[data-workspace-id="${invitationWorkspaceId}"]`);
  await expect(joined).toContainText("Rocket Team");
  await expect(joined).toContainText("Member");
  // The personal workspace remains its own separate view.
  await expect(page.getByRole("listitem")).toHaveCount(2);

  // The cookies the server just set are secrets the logs must never contain.
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

// A fresh invitation token from the catcher's copy of one email. The kind picks the link
// path, and workspaceName narrows a workspace invitation when a recipient has several.
async function caughtToken(
  client: APIRequestContext,
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string | undefined> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  const subject =
    kind === "installation" ? "Your Orrery invitation" : "Your Orrery workspace invitation";
  const pattern =
    kind === "installation"
      ? /\/register\?token=([A-Za-z0-9_-]+)/
      : /\/workspace-invitation\?token=([A-Za-z0-9_-]+)/;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== subject) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text: unknown = Reflect.get(caught, "Text");
    if (typeof text !== "string") continue;
    if (!caughtRecipients(caught).includes(to)) continue;
    if (workspaceName !== undefined && !text.includes(`"${workspaceName}"`)) continue;
    const token = text.match(pattern)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

function caughtRecipients(detail: object): string[] {
  const to: unknown = Reflect.get(detail, "To");
  if (!Array.isArray(to)) return [];
  return to.flatMap((entry): string[] => {
    const address: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "Address") : undefined;
    return typeof address === "string" ? [address] : [];
  });
}
