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
  // created through the installation invitation flow. A restarted worker re-runs this
  // hook after a failed test, when the account may already exist; signing in proves the
  // same credential and skips a duplicate invitation.
  const alreadyExists = await request.newContext({ baseURL: baseUrl });
  let knownAccount = false;
  try {
    const knownLogin = await alreadyExists.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    knownAccount = knownLogin.status() === 200;
  } finally {
    await alreadyExists.dispose();
  }
  if (!knownAccount) {
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
  }
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

test("resends a workspace invitation, and the old link stops working", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Resend Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  const sent = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: EXISTING_EMAIL },
  });
  expect(sent.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Resend Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const oldToken = await caughtToken(api, EXISTING_EMAIL, "workspace", "Resend Team");
  if (oldToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(oldToken);
  const id = await invitationId(api, workspace.id, EXISTING_EMAIL, "pending");

  const resent = await api.post(`/api/workspaces/${workspace.id}/invitations/${id}/resend`);
  expect(resent.status()).toBe(200);
  const fresh: unknown = await resent.json();
  if (typeof fresh !== "object" || fresh === null) throw new Error("the resend returned no body");
  expect(fresh).toMatchObject({
    email: EXISTING_EMAIL,
    status: "pending",
    target: { kind: "workspace", id: workspace.id, name: "Resend Team" },
    grants: [{ kind: "workspace_membership", workspaceId: workspace.id, role: "member" }],
    delivery: { status: "sent" },
  });
  const freshId: unknown = Reflect.get(fresh, "id");
  if (typeof freshId !== "string") throw new Error("the new invitation has no id");

  await expect
    .poll(
      async () => (await caughtTokens(api, EXISTING_EMAIL, "workspace", "Resend Team")).length,
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(1);
  const tokens = await caughtTokens(api, EXISTING_EMAIL, "workspace", "Resend Team");
  const newToken = tokens.find((token) => token !== oldToken);
  if (newToken === undefined) throw new Error("the catcher never received the resent invitation");
  await recordSecret(newToken);

  // History keeps the old row and the new one, with their separate lifecycles.
  const historyRes = await api.get(`/api/workspaces/${workspace.id}/invitations`);
  expect(historyRes.status()).toBe(200);
  const history: unknown = await historyRes.json();
  if (!Array.isArray(history)) throw new Error("the invitation history is not a list");
  expect(history).toContainEqual(expect.objectContaining({ id, status: "revoked" }));
  expect(history).toContainEqual(expect.objectContaining({ id: freshId, status: "pending" }));

  // The old link is dead; the new one shows the same scope and accepts.
  const oldPreview = await api.get(`/api/workspace-invitations/preview?token=${oldToken}`);
  expect(oldPreview.status()).toBe(400);
  expect(await oldPreview.json()).toMatchObject({ code: "invitation_invalid" });
  const newPreview = await api.get(`/api/workspace-invitations/preview?token=${newToken}`);
  expect(newPreview.status()).toBe(200);
  expect(await newPreview.json()).toMatchObject({
    workspaceId: workspace.id,
    workspaceName: "Resend Team",
    email: EXISTING_EMAIL,
    invitedByEmail: ADMIN_EMAIL,
    grants: [{ kind: "workspace_membership", workspaceId: workspace.id, role: "member" }],
  });

  const recipient = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await recipient.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const oldAttempt = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: oldToken },
    });
    expect(oldAttempt.status()).toBe(400);
    const accepted = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: newToken },
    });
    expect(accepted.status()).toBe(200);
    expect(await accepted.json()).toMatchObject({ id: workspace.id, name: "Resend Team" });
  } finally {
    await recipient.dispose();
  }
});

test("revokes and declines workspace invitations", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Lifecycle Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  const invited = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: EXISTING_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Lifecycle Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const revokedToken = await caughtToken(api, EXISTING_EMAIL, "workspace", "Lifecycle Team");
  if (revokedToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(revokedToken);
  const revokedId = await invitationId(api, workspace.id, EXISTING_EMAIL, "pending");

  const revoked = await api.post(`/api/workspaces/${workspace.id}/invitations/${revokedId}/revoke`);
  expect(revoked.status()).toBe(200);
  expect(await revoked.json()).toMatchObject({ id: revokedId, status: "revoked" });
  const revokedPreview = await api.get(`/api/workspace-invitations/preview?token=${revokedToken}`);
  expect(revokedPreview.status()).toBe(400);

  const recipient = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await recipient.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const refused = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: revokedToken },
    });
    expect(refused.status()).toBe(400);

    // A fresh offer to the same address is possible once the old one is resolved; the
    // recipient declines it from the emailed link, with no session at all.
    const reinvited = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
      data: { email: EXISTING_EMAIL },
    });
    expect(reinvited.status()).toBe(201);
    await expect
      .poll(
        async () => {
          const tokens = await caughtTokens(api, EXISTING_EMAIL, "workspace", "Lifecycle Team");
          return tokens.some((token) => token !== revokedToken);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const tokens = await caughtTokens(api, EXISTING_EMAIL, "workspace", "Lifecycle Team");
    const declinedToken = tokens.find((token) => token !== revokedToken);
    if (declinedToken === undefined) throw new Error("the catcher never received the new offer");
    await recordSecret(declinedToken);

    const declined = await recipient.post("/api/workspace-invitations/decline", {
      data: { token: declinedToken },
    });
    expect(declined.status()).toBe(204);
    const again = await recipient.post("/api/workspace-invitations/decline", {
      data: { token: declinedToken },
    });
    expect(again.status()).toBe(400);
    expect(await again.json()).toMatchObject({ code: "invitation_invalid" });
    const declinedPreview = await api.get(
      `/api/workspace-invitations/preview?token=${declinedToken}`,
    );
    expect(declinedPreview.status()).toBe(400);

    const historyRes = await api.get(`/api/workspaces/${workspace.id}/invitations`);
    const history: unknown = await historyRes.json();
    if (!Array.isArray(history)) throw new Error("the invitation history is not a list");
    expect(history).toContainEqual(expect.objectContaining({ id: revokedId, status: "revoked" }));
    expect(history).toContainEqual(
      expect.objectContaining({ email: EXISTING_EMAIL, status: "declined" }),
    );
  } finally {
    await recipient.dispose();
  }
});

test("an inviter removed as owner cannot have their invitation accepted", async () => {
  const RECIPIENT_EMAIL = "authority.recipient@orrery.test";
  const RECIPIENT_PASSWORD = "authority-recipient-password";
  await recordSecret(RECIPIENT_PASSWORD);

  // A real account for the recipient, through the installation invitation flow.
  const invited = await api.post("/api/invitations/installation", {
    data: { email: RECIPIENT_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, RECIPIENT_EMAIL, "installation"), { timeout: 15_000 })
    .toBeTruthy();
  const registrationToken = await caughtToken(api, RECIPIENT_EMAIL, "installation");
  if (registrationToken === undefined)
    throw new Error("the catcher never received the installation invitation");
  await recordSecret(registrationToken);
  const registration = await api.post("/api/invitations/installation/registration", {
    data: { token: registrationToken, password: RECIPIENT_PASSWORD },
  });
  expect(registration.status()).toBe(200);

  const created = await api.post("/api/workspaces", { data: { name: "Authority Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  // An existing account joins and is appointed, so the administrator can leave.
  const memberInvite = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: EXISTING_EMAIL },
  });
  expect(memberInvite.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Authority Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const memberToken = await caughtToken(api, EXISTING_EMAIL, "workspace", "Authority Team");
  if (memberToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(memberToken);
  const member = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await member.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const accepted = await member.post("/api/workspace-invitations/acceptance", {
      data: { token: memberToken },
    });
    expect(accepted.status()).toBe(200);
  } finally {
    await member.dispose();
  }

  const membersRes = await api.get(`/api/workspaces/${workspace.id}/members`);
  const members: unknown = await membersRes.json();
  if (!Array.isArray(members)) throw new Error("the member directory is not a list");
  const memberEntry = members.find(
    (entry) =>
      typeof entry === "object" && entry !== null && Reflect.get(entry, "email") === EXISTING_EMAIL,
  );
  if (typeof memberEntry !== "object" || memberEntry === null)
    throw new Error("the member is not in the directory");
  const memberId: unknown = Reflect.get(memberEntry, "humanId");
  if (typeof memberId !== "string") throw new Error("the member has no id");
  const appointed = await api.post(`/api/workspaces/${workspace.id}/owners`, {
    data: { humanId: memberId },
  });
  expect(appointed.status()).toBe(200);

  // The administrator invites the recipient, then leaves; the pending offer loses its
  // inviter's authority even though the workspace still has another owner.
  const recipientInvite = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: RECIPIENT_EMAIL },
  });
  expect(recipientInvite.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, RECIPIENT_EMAIL, "workspace", "Authority Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const pendingToken = await caughtToken(api, RECIPIENT_EMAIL, "workspace", "Authority Team");
  if (pendingToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(pendingToken);

  const adminEntry = members.find(
    (entry) =>
      typeof entry === "object" && entry !== null && Reflect.get(entry, "email") === ADMIN_EMAIL,
  );
  if (typeof adminEntry !== "object" || adminEntry === null)
    throw new Error("the administrator is not in the directory");
  const adminId: unknown = Reflect.get(adminEntry, "humanId");
  if (typeof adminId !== "string") throw new Error("the administrator has no id");
  const left = await api.delete(`/api/workspaces/${workspace.id}/members/${adminId}`);
  expect(left.status()).toBe(204);

  const recipient = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await recipient.post("/api/auth/login", {
      data: { email: RECIPIENT_EMAIL, password: RECIPIENT_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const refused = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: pendingToken },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "inviter_not_authorized" });
    const stillPending = await api.get(`/api/workspace-invitations/preview?token=${pendingToken}`);
    expect(stillPending.status()).toBe(200);
  } finally {
    await recipient.dispose();
  }
});

test("owner sees invitation history and delivery separately, and resends from the page", async ({
  page,
}) => {
  const HISTORY_EMAIL = "history.person@orrery.test";
  const created = await api.post("/api/workspaces", { data: { name: "History Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();
  const invited = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: HISTORY_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, HISTORY_EMAIL, "workspace", "History Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const before = await caughtTokens(api, HISTORY_EMAIL, "workspace", "History Team");
  for (const token of before) await recordSecret(token);

  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  await page.goto(`/workspaces/${workspace.id}`);
  await expect(page.getByRole("heading", { name: "Invitation history" })).toBeVisible();
  const row = page.locator("li[data-invitation-id]").filter({ hasText: HISTORY_EMAIL });
  await expect(row).toContainText("Pending");
  await expect(row).toContainText("Email sent");
  await expect(row).toContainText(`Invited by ${ADMIN_EMAIL}`);
  await expect(row).toContainText("Workspace member");
  await expect(row.getByRole("button", { name: "Resend" })).toBeVisible();

  await row.getByRole("button", { name: "Resend" }).click();
  await expect
    .poll(
      async () => (await caughtTokens(api, HISTORY_EMAIL, "workspace", "History Team")).length,
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(before.length);
  for (const token of await caughtTokens(api, HISTORY_EMAIL, "workspace", "History Team")) {
    await recordSecret(token);
  }
  await expect(page.locator("li[data-invitation-id]")).toHaveCount(2);
  await expect(page.locator('li[data-invitation-status="revoked"]')).toHaveCount(1);
  const pending = page.locator('li[data-invitation-status="pending"]');
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText("Email sent");

  // Revoking from the page resolves the new offer and leaves both history rows.
  await pending.getByRole("button", { name: "Revoke" }).click();
  await expect(page.locator('li[data-invitation-status="revoked"]')).toHaveCount(2);
  await expect(page.locator('li[data-invitation-status="pending"]')).toHaveCount(0);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("accepts a workspace invitation through sign-in, then an owner appoints", async ({
  page,
  browser,
}) => {
  expect(invitationToken).not.toBe("");
  expect(invitationWorkspaceId).not.toBe("");

  // Start signed out at the emailed link, exactly as a recipient would.
  await page.goto(`/workspace-invitation?token=${invitationToken}`);
  await expect(page.getByRole("heading", { name: "Join Rocket Team" })).toBeVisible();
  await expect(
    page.getByText(`Sign in with ${EXISTING_EMAIL} to join the workspace`),
  ).toBeVisible();
  // The whole offer, before accepting: inviter, workspace, access, and deadline.
  await expect(page.getByText(`${ADMIN_EMAIL} invited ${EXISTING_EMAIL} to`)).toBeVisible();
  await expect(
    page.getByText(
      "Offered access: Workspace member. Workspace membership alone does not grant project access.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/This invitation expires/)).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/signin\?next=/);
  await page.getByLabel("Email").fill(EXISTING_EMAIL);
  await page.getByLabel("Password").fill(EXISTING_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Sign-in resumes the same invitation rather than dropping the token.
  await expect(page).toHaveURL(new RegExp(`/workspace-invitation\\?token=${invitationToken}`));
  await expect(page.getByRole("heading", { name: "Join Rocket Team" })).toBeVisible();
  await expect(page.getByText(`You are signed in as ${EXISTING_EMAIL}.`)).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();

  // Acceptance leads into the workspace's own view, distinct from the personal one.
  await expect(page.getByRole("heading", { name: "Rocket Team" })).toBeVisible();
  await expect(page.getByText("Shared workspace · Member")).toBeVisible();
  // A member gets no owner controls: no directory and no appointment action.
  await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make owner" })).toHaveCount(0);

  // The owner sees the directory and appoints the member. The role refreshes in place.
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto("/signin");
    await adminPage.getByLabel("Email").fill(ADMIN_EMAIL);
    await adminPage.getByLabel("Password").fill(ADMIN_PASSWORD);
    await adminPage.getByRole("button", { name: "Sign in" }).click();
    await expect(adminPage.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    await adminPage.goto(`/workspaces/${invitationWorkspaceId}`);
    await expect(adminPage.getByRole("heading", { name: "Members" })).toBeVisible();
    const memberRow = adminPage.locator("li[data-member-id]").filter({ hasText: EXISTING_EMAIL });
    await expect(memberRow).toContainText("Member");
    await memberRow.getByRole("button", { name: "Make owner" }).click();
    await expect(memberRow).toContainText("Owner");
    await expect(memberRow.getByRole("button", { name: "Make owner" })).toHaveCount(0);

    // The member's next load sees the new role and the owner-only controls.
    await page.reload();
    await expect(page.getByText("Shared workspace · Owner")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  } finally {
    for (const cookie of await adminContext.cookies()) await recordSecret(cookie.value);
    await adminContext.close();
  }

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  const joined = page.locator(`li[data-workspace-id="${invitationWorkspaceId}"]`);
  await expect(joined).toContainText("Rocket Team");
  await expect(joined).toContainText("Owner");
  // The personal workspace remains its own separate view, whatever other memberships
  // the account has by this point.
  await expect(
    page.locator("main li[data-workspace-id]").filter({ hasText: "Personal" }),
  ).toHaveCount(1);

  // The cookies the server just set are secrets the logs must never contain.
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("distinguishes an invalid invitation link from a load failure", async ({ page }) => {
  // A network failure is not an invalid link, and must not claim one.
  await page.route("**/api/workspace-invitations/preview*", (route) => route.abort());
  await page.goto("/workspace-invitation?token=network-failure");
  await expect(page.getByRole("alert")).toHaveText(
    "Could not load this invitation. Check your connection and try again.",
  );
  await page.unroute("**/api/workspace-invitations/preview*");

  // A real invalid-token Problem keeps its stable code, so only this case says invalid.
  await page.goto("/workspace-invitation?token=not-an-issued-token");
  await expect(page.getByRole("alert")).toHaveText(
    "This invitation is invalid, expired, or already used.",
  );

  // Malformed and overlong tokens are rejected at the route boundary with the same
  // invalid-link copy, without a server request or a connectivity message.
  let sessionRequests = 0;
  await page.route("**/api/auth/session", (route) => {
    sessionRequests += 1;
    return route.abort();
  });
  for (const token of ["bad token", "a".repeat(1_025)]) {
    await page.goto(`/workspace-invitation?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole("alert")).toHaveText(
      "This invitation is invalid, expired, or already used.",
    );
  }
  expect(sessionRequests).toBe(0);
});

test("ignores a sign-in redirect that is not the invitation page", async ({ page }) => {
  await page.goto("/signin?next=https%3A%2F%2Fexample.com%2Fsteal");
  await page.getByLabel("Email").fill(EXISTING_EMAIL);
  await page.getByLabel("Password").fill(EXISTING_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The only accepted destination is the internal invitation path; everything else
  // lands on the normal signed-in home.
  await expect(page.getByText(`Signed in as ${EXISTING_EMAIL}.`)).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(baseUrl).origin);
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

// One invitation's id from the owner's history, optionally narrowed by lifecycle state.
async function invitationId(
  client: APIRequestContext,
  workspaceId: string,
  email: string,
  status?: string,
): Promise<string> {
  const res = await client.get(`/api/workspaces/${workspaceId}/invitations`);
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the invitation history is not a list");
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    if (Reflect.get(entry, "email") !== email) continue;
    if (status !== undefined && Reflect.get(entry, "status") !== status) continue;
    const id: unknown = Reflect.get(entry, "id");
    if (typeof id === "string") return id;
  }
  throw new Error(`no ${status ?? "matching"} invitation for ${email}`);
}

// A fresh invitation token from the catcher's copy of one email. The kind picks the link
// path, and workspaceName narrows a workspace invitation when a recipient has several.
async function caughtToken(
  client: APIRequestContext,
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string | undefined> {
  const tokens = await caughtTokens(client, to, kind, workspaceName);
  return tokens[0];
}

// Every matching token, for a resend where the old and new emails share a recipient and
// subject. Order is the catcher's, so callers compare sets rather than positions.
async function caughtTokens(
  client: APIRequestContext,
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string[]> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return [];
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return [];
  const subject =
    kind === "installation" ? "Your Orrery invitation" : "Your Orrery workspace invitation";
  const pattern =
    kind === "installation"
      ? /\/register\?token=([A-Za-z0-9_-]+)/
      : /\/workspace-invitation\?token=([A-Za-z0-9_-]+)/;
  const tokens: string[] = [];
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
    if (token !== undefined && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
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
