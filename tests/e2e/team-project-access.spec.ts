// Shared project access (issue #27), black-box against a running Orrery. The owner
// creates a shared project, grants a member Create projects, and the member receives
// Manage on the project they create. A direct-request matrix proves Read cannot mutate,
// Contribute can work, Manage can configure and grant access, membership alone reveals
// nothing, cross-workspace and personal projects stay private, and the system
// administrator gets no project access from the role. The browser check grants access
// through the UI and shows a Read project without mutation controls.
//
// Runs after smtp.spec.ts (alphabetical file order, one worker), which verified the
// administrator, so workspace invitations can be sent. This suite still saves the catcher
// settings and verifies the administrator when needed, so it stands on its own. It
// creates its own accounts through the invitation flows, so no other spec's accounts are
// assumed.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
const baseUrl: string = configuredUrl;

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;

const MEMBER_EMAIL = "access.member@orrery.test";
const MEMBER_PASSWORD = "access-member-password";
const COLLEAGUE_EMAIL = "access.colleague@orrery.test";
const COLLEAGUE_PASSWORD = "access-colleague-password";
const OUTSIDER_EMAIL = "access.outsider@orrery.test";
const OUTSIDER_PASSWORD = "access-outsider-password";

let adminApi: APIRequestContext;
let memberApi: APIRequestContext;
let colleagueApi: APIRequestContext;
let outsiderApi: APIRequestContext;

let workspaceId = "";
let memberHumanId = "";
let projectId = "";
let memberProjectId = "";
let colleagueHumanId = "";
let adminPersonalProjectId = "";
let adminPersonalWorkspaceId = "";
let outsiderPersonalProjectId = "";

test.beforeAll(async () => {
  for (const value of [MEMBER_PASSWORD, COLLEAGUE_PASSWORD, OUTSIDER_PASSWORD]) {
    await recordSecret(value);
  }

  adminApi = await newContext();
  await signIn(adminApi, ADMIN_EMAIL, ADMIN_PASSWORD);
  const saved = await adminApi.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);
  // Workspace invitations require a verified inviter. On a fresh installation the
  // bootstrap administrator is unverified until this suite (smtp.spec.ts would do it
  // later, but this file must stand before it).
  await ensureAdminVerified();

  // The shared workspace and its owner.
  const created = await adminApi.post("/api/workspaces", { data: { name: "Access Lab" } });
  expect(created.status()).toBe(201);
  workspaceId = requiredText(field(await created.json(), "id"), "the workspace id");

  // Two members through workspace invitations: one who receives the full matrix, one
  // who receives a grant later. Registration creates each account, personal workspace,
  // and membership in one flow.
  memberApi = await registeredMember(MEMBER_EMAIL, MEMBER_PASSWORD, "Access Lab");
  colleagueApi = await registeredMember(COLLEAGUE_EMAIL, COLLEAGUE_PASSWORD, "Access Lab");
  outsiderApi = await installedOutsider();

  // The member's id, used for the workspace capability request.
  const members = await adminApi.get(`/api/workspaces/${workspaceId}/members`);
  expect(members.status()).toBe(200);
  memberHumanId = humanIdFor(await members.json(), MEMBER_EMAIL);
  colleagueHumanId = humanIdFor(await members.json(), COLLEAGUE_EMAIL);

  // The owner's shared project, a member's project with no access yet, and the two
  // personal projects the denial cases target.
  projectId = await createProjectAs(adminApi, workspaceId, "Access Lab Project");
  const adminWorkspaces = await adminApi.get("/api/workspaces");
  adminPersonalWorkspaceId = personalWorkspaceOf(await adminWorkspaces.json());
  adminPersonalProjectId = await createProjectAs(
    adminApi,
    adminPersonalWorkspaceId,
    "Private Admin Project",
  );
  const outsiderWorkspaces = await outsiderApi.get("/api/workspaces");
  outsiderPersonalProjectId = await createProjectAs(
    outsiderApi,
    personalWorkspaceOf(await outsiderWorkspaces.json()),
    "Private Outsider Project",
  );

  // Create projects is granted by the owner; the member creates a project and receives
  // Manage. The REST matrix exercises the other levels on the owner's project.
  const capability = await adminApi.patch(
    `/api/workspaces/${workspaceId}/members/${memberHumanId}`,
    {
      data: { canCreateProjects: true },
    },
  );
  expect(capability.status()).toBe(200);
  memberProjectId = await createProjectAs(memberApi, workspaceId, "Member Project");

  await grant(adminApi, projectId, MEMBER_EMAIL, "read");
});

test.afterAll(async () => {
  for (const client of [adminApi, memberApi, colleagueApi, outsiderApi]) await client?.dispose();
});

test("enforces the direct-request matrix for every level", async () => {
  // Read: every read path succeeds; every mutation and management path is refused.
  const issue = await createIssueAs(adminApi, projectId, "Owner issue");
  const knowledge = await createKnowledgeAs(adminApi, projectId, "Owner knowledge");

  for (const path of [
    `/api/projects/${projectId}`,
    `/api/projects/${projectId}/issues`,
    `/api/issues/${requiredText(field(issue, "id"), "the issue id")}`,
    `/api/issues/${requiredText(field(issue, "id"), "the issue id")}/comments`,
    `/api/projects/${projectId}/activity`,
    `/api/projects/${projectId}/knowledge`,
    `/api/knowledge/${requiredText(field(knowledge, "id"), "the knowledge id")}`,
  ]) {
    expect((await memberApi.get(path)).status(), path).toBe(200);
  }

  const readDenials = [
    await memberApi.post(`/api/projects/${projectId}/issues`, { data: { title: "No" } }),
    await memberApi.patch(`/api/issues/${requiredText(field(issue, "id"), "the issue id")}`, {
      data: { status: "done" },
    }),
    await memberApi.post(
      `/api/issues/${requiredText(field(issue, "id"), "the issue id")}/comments`,
      {
        data: { body: "No" },
      },
    ),
    await memberApi.post(`/api/projects/${projectId}/knowledge`, { data: { title: "No" } }),
    await memberApi.patch(
      `/api/knowledge/${requiredText(field(knowledge, "id"), "the knowledge id")}`,
      { data: { title: "No" } },
    ),
    await memberApi.patch(`/api/projects/${projectId}`, { data: { name: "No" } }),
    await memberApi.get(`/api/projects/${projectId}/access`),
    await memberApi.patch(`/api/projects/${projectId}/access`, {
      data: { email: COLLEAGUE_EMAIL, level: "read" },
    }),
  ];
  for (const res of readDenials) {
    expect(res.status()).toBe(403);
    expect(res.headers()["content-type"]).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 403, code: "insufficient_project_access" });
  }

  // Contribute: create, edit, close/reopen, comment, and knowledge work; configuration
  // and access management still do not.
  await grant(adminApi, projectId, MEMBER_EMAIL, "contribute");
  const memberIssue = await createIssueAs(memberApi, projectId, "Member issue");
  const memberIssueId = requiredText(field(memberIssue, "id"), "the member issue id");
  expect(
    (
      await memberApi.patch(`/api/issues/${memberIssueId}`, {
        data: { title: "Member issue edited" },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await memberApi.patch(`/api/issues/${memberIssueId}`, { data: { status: "done" } })).status(),
  ).toBe(200);
  expect(
    (await memberApi.patch(`/api/issues/${memberIssueId}`, { data: { status: "todo" } })).status(),
  ).toBe(200);
  expect(
    (
      await memberApi.post(`/api/issues/${memberIssueId}/comments`, {
        data: { body: "A member comment." },
      })
    ).status(),
  ).toBe(201);
  const memberKnowledge = await createKnowledgeAs(memberApi, projectId, "Member knowledge");
  expect(
    (
      await memberApi.patch(
        `/api/knowledge/${requiredText(field(memberKnowledge, "id"), "the member knowledge id")}`,
        { data: { body: "Updated in the matrix." } },
      )
    ).status(),
  ).toBe(200);
  expect(
    (await memberApi.patch(`/api/projects/${projectId}`, { data: { name: "No" } })).status(),
  ).toBe(403);
  expect((await memberApi.get(`/api/projects/${projectId}/access`)).status()).toBe(403);

  // Manage: rename, see grants, grant a colleague, and revoke. The colleague can read
  // only while the grant exists.
  await grant(adminApi, projectId, MEMBER_EMAIL, "manage");
  const renamed = await memberApi.patch(`/api/projects/${projectId}`, {
    data: { name: "Access Lab Project Renamed" },
  });
  expect(renamed.status()).toBe(200);
  expect(await renamed.json()).toMatchObject({
    name: "Access Lab Project Renamed",
    accessLevel: "manage",
  });
  expect((await memberApi.get(`/api/projects/${projectId}/access`)).status()).toBe(200);

  const colleagueGrant = await grant(memberApi, projectId, COLLEAGUE_EMAIL, "read");
  expect(colleagueGrant).toMatchObject({ email: COLLEAGUE_EMAIL, level: "read" });
  expect((await colleagueApi.get(`/api/projects/${projectId}`)).status()).toBe(200);
  const revoked = await memberApi.delete(`/api/projects/${projectId}/access/${colleagueHumanId}`);
  expect(revoked.status()).toBe(204);
  expect((await colleagueApi.get(`/api/projects/${projectId}`)).status()).toBe(404);

  // A grant to a non-member is refused; the outsider was never in this workspace.
  expect(
    (
      await memberApi.patch(`/api/projects/${projectId}/access`, {
        data: { email: OUTSIDER_EMAIL, level: "read" },
      })
    ).status(),
  ).toBe(404);

  // Membership alone grants no project access; the colleague's listing stays empty and
  // a direct fetch is the same as a missing project.
  const colleagueList = await colleagueApi.get(`/api/workspaces/${workspaceId}/projects`);
  expect(colleagueList.status()).toBe(200);
  expect(await colleagueList.json()).toEqual([]);
  expect((await colleagueApi.get(`/api/projects/${projectId}`)).status()).toBe(404);

  // The member's created project is theirs to manage, and only theirs to see.
  expect(await (await memberApi.get(`/api/projects/${memberProjectId}`)).json()).toMatchObject({
    id: memberProjectId,
    accessLevel: "manage",
    workspaceKind: "shared",
  });
  expect((await colleagueApi.get(`/api/projects/${memberProjectId}`)).status()).toBe(404);

  // The owner manages every project in the workspace, including the member's.
  const ownerRename = await adminApi.patch(`/api/projects/${memberProjectId}`, {
    data: { name: "Member Project Renamed" },
  });
  expect(ownerRename.status()).toBe(200);
  expect(await ownerRename.json()).toMatchObject({
    id: memberProjectId,
    name: "Member Project Renamed",
    accessLevel: "manage",
  });

  // Cross-workspace denial and personal-project privacy.
  expect((await outsiderApi.get(`/api/projects/${projectId}`)).status()).toBe(404);
  expect((await outsiderApi.get(`/api/workspaces/${workspaceId}/projects`)).status()).toBe(404);
  expect((await outsiderApi.get(`/api/projects/${adminPersonalProjectId}`)).status()).toBe(404);
  expect((await memberApi.get(`/api/projects/${adminPersonalProjectId}`)).status()).toBe(404);

  // The system administrator's role does not open another human's personal project or
  // another team's shared workspace/project.
  expect((await adminApi.get(`/api/projects/${outsiderPersonalProjectId}`)).status()).toBe(404);
  expect(
    (
      await adminApi.get(`/api/workspaces/${await personalWorkspaceOfApi(outsiderApi)}/projects`)
    ).status(),
  ).toBe(404);

  const outsiderSharedWs = await outsiderApi.post("/api/workspaces", {
    data: { name: "Outsider Team" },
  });
  expect(outsiderSharedWs.status()).toBe(201);
  const outsiderSharedId = field(await outsiderSharedWs.json(), "id");
  if (typeof outsiderSharedId !== "string") throw new Error("missing outsider shared workspace id");
  const outsiderSharedProj = await outsiderApi.post(
    `/api/workspaces/${outsiderSharedId}/projects`,
    { data: { name: "Outsider Shared Project" } },
  );
  expect(outsiderSharedProj.status()).toBe(201);
  const outsiderSharedProjId = field(await outsiderSharedProj.json(), "id");
  if (typeof outsiderSharedProjId !== "string")
    throw new Error("missing outsider shared project id");
  expect((await adminApi.get(`/api/workspaces/${outsiderSharedId}/projects`)).status()).toBe(404);
  expect((await adminApi.get(`/api/projects/${outsiderSharedProjId}`)).status()).toBe(404);
});

test("grants access in the browser and shows Read without mutation controls", async ({
  page,
  browser,
}) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  // The owner grants the colleague Contribute through the project page.
  await page.goto(`/projects/${projectId}`);
  await page.getByLabel("Email").fill(COLLEAGUE_EMAIL);
  await page.getByLabel("Access level").selectOption("contribute");
  await page.getByRole("button", { name: "Grant access" }).click();
  const grantRow = page.locator(`li[data-project-access-for="${COLLEAGUE_EMAIL}"]`);
  await expect(grantRow).toContainText("contribute");
  await expect(grantRow).toContainText(ADMIN_EMAIL);

  // The owner also toggles the workspace capability in the member directory.
  await page.goto(`/workspaces/${workspaceId}`);
  const memberRow = page.locator(`li[data-member-id="${memberHumanId}"]`);
  await expect(memberRow).toContainText("Can create projects");
  await memberRow.getByRole("button", { name: "Revoke Create projects" }).click();
  await expect(memberRow).toContainText("Cannot create projects");
  await memberRow.getByRole("button", { name: "Grant Create projects" }).click();
  await expect(memberRow).toContainText("Can create projects");

  // A Read colleague sees the project but no mutation, configuration, or access form.
  const colleagueContext = await browser.newContext();
  const colleaguePage = await colleagueContext.newPage();
  try {
    await colleaguePage.goto("/signin");
    await colleaguePage.getByLabel("Email").fill(COLLEAGUE_EMAIL);
    await colleaguePage.getByLabel("Password").fill(COLLEAGUE_PASSWORD);
    await colleaguePage.getByRole("button", { name: "Sign in" }).click();
    await expect(colleaguePage.getByText(`Signed in as ${COLLEAGUE_EMAIL}.`)).toBeVisible();

    // Set the matrix's final grant to Read through the API, then load the project.
    await grant(adminApi, projectId, COLLEAGUE_EMAIL, "read");
    await colleaguePage.goto(`/projects/${projectId}`);
    await expect(
      colleaguePage.getByRole("heading", { name: "Access Lab Project Renamed" }),
    ).toBeVisible();
    await expect(colleaguePage.locator('[data-project-access-level="read"]').first()).toBeVisible();
    await expect(colleaguePage.getByRole("button", { name: "Create issue" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("button", { name: "Create knowledge" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("heading", { name: "Project settings" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("heading", { name: "Project access" })).toHaveCount(0);

    // The same holds on an issue: no close, edit, or comment controls.
    const firstIssue = colleaguePage.locator("[data-issue-id] a").first();
    await firstIssue.click();
    await expect(colleaguePage.getByRole("button", { name: "Close issue" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("button", { name: "Save issue" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("button", { name: "Add comment" })).toHaveCount(0);
  } finally {
    for (const cookie of await colleagueContext.cookies()) await recordSecret(cookie.value);
    await colleagueContext.close();
  }

  // The cookies the server just set are secrets the logs must never contain.
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

// A signed-in API context. A failed login fails the setup, not a later assertion.
async function newContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: baseUrl });
}

async function signIn(client: APIRequestContext, email: string, password: string) {
  const login = await client.post("/api/auth/login", { data: { email, password } });
  expect(login.status()).toBe(200);
}

// The bootstrap administrator starts unverified. Send the installation's test email,
// read its single-use token from the catcher, and redeem it by POST. On a rerun where an
// earlier suite already verified the address, no mail is needed.
async function ensureAdminVerified() {
  const session = await adminApi.get("/api/auth/session");
  expect(session.status()).toBe(200);
  const state = (await session.json()) as unknown;
  if (field(state, "emailVerified") === true) return;

  const sent = await adminApi.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);
  await expect.poll(async () => verificationMessageText(), { timeout: 15_000 }).toBeTruthy();
  const text = await verificationMessageText();
  if (text === undefined) throw new Error("the catcher never received the verification email");
  const token = text.match(/Single-use token, valid for 24 hours:\r?\n\r?\n([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error("the verification email carried no token");
  await recordSecret(token);

  const verified = await adminApi.post("/api/settings/email-verification", {
    data: { token },
  });
  expect(verified.status()).toBe(200);
  expect(await verified.json()).toEqual({ email: ADMIN_EMAIL, emailVerified: true });
}

// The latest verification email's text, or undefined while the catcher has none yet.
async function verificationMessageText(): Promise<string | undefined> {
  const list = await adminApi.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== "Verify your Orrery email") continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await adminApi.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text: unknown = Reflect.get(caught, "Text");
    if (typeof text !== "string") continue;
    if (!caughtRecipients(caught).includes(ADMIN_EMAIL)) continue;
    return text;
  }
  return undefined;
}

async function registeredMember(
  email: string,
  password: string,
  workspaceName: string,
): Promise<APIRequestContext> {
  const invited = await adminApi.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(email, "workspace", workspaceName), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtToken(email, "workspace", workspaceName);
  if (token === undefined) throw new Error(`the catcher never received ${email}'s invitation`);
  await recordSecret(token);
  const registered = await request.newContext({ baseURL: baseUrl });
  const accepted = await registered.post("/api/workspace-invitations/registration", {
    data: { token, password },
  });
  expect(accepted.status()).toBe(200);
  await registered.dispose();

  const client = await newContext();
  await signIn(client, email, password);
  return client;
}

async function installedOutsider(): Promise<APIRequestContext> {
  const invited = await adminApi.post("/api/invitations/installation", {
    data: { email: OUTSIDER_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(OUTSIDER_EMAIL, "installation"), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtToken(OUTSIDER_EMAIL, "installation");
  if (token === undefined) throw new Error("the catcher never received the outsider invitation");
  await recordSecret(token);
  const registered = await request.newContext({ baseURL: baseUrl });
  const accepted = await registered.post("/api/invitations/installation/registration", {
    data: { token, password: OUTSIDER_PASSWORD },
  });
  expect(accepted.status()).toBe(200);
  await registered.dispose();

  const client = await newContext();
  await signIn(client, OUTSIDER_EMAIL, OUTSIDER_PASSWORD);
  return client;
}

async function createProjectAs(
  client: APIRequestContext,
  targetWorkspaceId: string,
  name: string,
): Promise<string> {
  const created = await client.post(`/api/workspaces/${targetWorkspaceId}/projects`, {
    data: { name },
  });
  expect(created.status()).toBe(201);
  return requiredText(field(await created.json(), "id"), "the project id");
}

async function createIssueAs(client: APIRequestContext, targetProjectId: string, title: string) {
  const created = await client.post(`/api/projects/${targetProjectId}/issues`, {
    data: { title },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as unknown;
}

async function createKnowledgeAs(
  client: APIRequestContext,
  targetProjectId: string,
  title: string,
) {
  const created = await client.post(`/api/projects/${targetProjectId}/knowledge`, {
    data: { title },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as unknown;
}

async function grant(
  client: APIRequestContext,
  targetProjectId: string,
  email: string,
  level: "read" | "contribute" | "manage",
) {
  const res = await client.patch(`/api/projects/${targetProjectId}/access`, {
    data: { email, level },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as unknown;
}

async function personalWorkspaceOfApi(client: APIRequestContext): Promise<string> {
  return personalWorkspaceOf(await (await client.get("/api/workspaces")).json());
}

function personalWorkspaceOf(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("the workspaces listing is not a list");
  for (const workspace of value) {
    if (field(workspace, "kind") !== "personal") continue;
    const id = field(workspace, "id");
    if (typeof id === "string") return id;
  }
  throw new Error("the account has no personal workspace");
}

function humanIdFor(value: unknown, email: string): string {
  if (!Array.isArray(value)) throw new Error("the members listing is not a list");
  for (const member of value) {
    if (field(member, "email") !== email) continue;
    const id = field(member, "humanId");
    if (typeof id === "string") return id;
  }
  throw new Error(`the workspace has no member ${email}`);
}

// A fresh invitation token from the catcher's copy of one email.
async function caughtToken(
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string | undefined> {
  const list = await adminApi.get(`${mailpit}/api/v1/messages`);
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
    const detail = await adminApi.get(`${mailpit}/api/v1/message/${id}`);
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

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}
