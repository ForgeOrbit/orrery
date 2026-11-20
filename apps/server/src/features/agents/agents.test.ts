import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AgentIdentity, CreateAgentKeyResponse, Problem, tools } from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  issueComments,
  issues,
  knowledgeEntries,
  projectActivity,
  runs as runRows,
  agentApiKeyProjects,
  agentApiKeys,
  agentKeyEvents,
  browserSessions,
  humans,
  projectAccessGrants,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import {
  createProjectsFeature,
  ProjectsError,
  type ProjectsErrorKind,
  type WorkSessionGate,
} from "../projects/index.ts";
import { createSessionsFeature, type SessionsService } from "../work-sessions/index.ts";
import { createAgentsFeature, type AgentAuthenticator } from "./index.ts";

// Real Postgres (AGENTS.md): key scoping, revocation, expiry, the dynamic human-access
// ceiling, and credential audit events are database behavior. The black-box e2e suite
// repeats the externally visible flows against the built server.

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const MEMBER_EMAIL = "member@example.com";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string, bearer?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getJson = (app: Hono, path: string, cookie?: string, bearer?: string) =>
  app.request(
    path,
    cookie || bearer
      ? {
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
        }
      : {},
  );

const patchJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const deleteRequest = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what} id`);
  return id;
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

let pg: StartedPostgreSqlContainer;
let database: Database;

async function makeApp(): Promise<Hono> {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
  });
  return createApp({
    features: [
      accounts,
      projectsFeature,
      createAgentsFeature({
        db: database.db,
        sessionReader: accounts.sessionReader,
        projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
          projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
        projectAccessAtLeast: (actual, required) =>
          ["read", "contribute", "manage"].indexOf(actual) >=
          ["read", "contribute", "manage"].indexOf(required),
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
}

// #36 fences an agent's issue edits on a live session. The project-work test app wires the
// real gate through the same late-bound seam as production, so a test must claim a run
// before an agent can edit, close or reopen an issue.
async function makeProjectWorkApp() {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  let gate: WorkSessionGate | undefined;
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: (tx, agentId, workspaceId, issueId) => {
      if (gate === undefined) throw new Error("session gate not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
  });
  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: async () => null,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
    listIssues: (actor, projectId) => projectsFeature.service.listIssues(actor, projectId),
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  const app = createApp({
    features: [
      accounts,
      projectsFeature,
      sessionsFeature,
      createAgentsFeature({
        db: database.db,
        sessionReader: accounts.sessionReader,
        projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
          projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
        projectAccessAtLeast: (actual, required) =>
          ["read", "contribute", "manage"].indexOf(actual) >=
          ["read", "contribute", "manage"].indexOf(required),
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
  return { app, projects: projectsFeature.service, sessions: sessionsFeature.service };
}

// A run row plus a claim: the fixture an #33 test needs before an agent may edit an issue.
async function claimIssue(
  sessions: SessionsService,
  identity: AgentIdentity,
  issueId: string,
): Promise<void> {
  const [run] = await database.db
    .insert(runRows)
    .values({
      id: randomUUID(),
      agentId: identity.agentId,
      workspaceId: identity.workspaceId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: runRows.id });
  if (run === undefined) throw new Error("the run was not created");
  await sessions.claim({ kind: "agent", identity }, { issueId, runId: run.id });
}

// The real feature wiring for bearer-backed project REST routes: projects borrows the
// agents authenticator through one late-bound seam, as features/index.ts does.
async function makeBearerApp() {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  let authenticator: AgentAuthenticator | undefined;
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: (request) => {
      if (authenticator === undefined) throw new Error("authenticator not wired");
      return authenticator(request);
    },
    sessionGate: async () => true,
  });
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
  });
  authenticator = agentsFeature.authenticator;
  return {
    app: createApp({
      features: [accounts, projectsFeature, agentsFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    }),
    projects: projectsFeature.service,
  };
}

async function adminId(): Promise<string> {
  const [human] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
  if (human === undefined) throw new Error("the administrator was not created");
  return human.id;
}

async function identityFor(app: Hono, secret: string): Promise<AgentIdentity> {
  const res = await getJson(app, "/api/agents/me", undefined, secret);
  expect(res.status).toBe(200);
  return AgentIdentity.parse(await res.json());
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the operation to be rejected");
    },
    (error: unknown) => error,
  );
}

function humanActor(humanId: string, email: string) {
  return {
    kind: "human" as const,
    account: {
      humanId,
      email,
      isSystemAdministrator: false,
      emailVerifiedAt: new Date(),
    },
  };
}

function expectProjectsError(error: unknown, kind: ProjectsErrorKind) {
  expect(error).toBeInstanceOf(ProjectsError);
  expect(error).toMatchObject({ kind });
}

async function bootstrapAdmin(app: Hono) {
  const res = await postJson(app, "/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(res.status).toBe(201);
}

async function cookieFor(app: Hono, email: string, password: string) {
  const res = await postJson(app, "/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  return cookie;
}

async function insertHuman(email: string) {
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`now()`,
    })
    .returning();
  if (human === undefined) throw new Error("the human was not created");
  return human;
}

// Direct session fixture: the token is the only place the secret lives; the row keeps
// its hash, exactly like the accounts feature's own sessions.
async function createSession(humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    expiresAt: sql`now() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

// Bootstrap already creates the administrator's personal workspace.
async function personalWorkspaceOf(humanId: string) {
  const [workspace] = await database.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("the personal workspace was not found");
  return workspace;
}

async function personalWorkspace(humanId: string) {
  const [workspace] = await database.db
    .insert(workspaces)
    .values({ id: randomUUID(), kind: "personal", name: "Personal", personalOwnerHumanId: humanId })
    .returning();
  if (workspace === undefined) throw new Error("the personal workspace was not created");
  return workspace;
}

async function sharedWorkspace(name: string, ownerHumanId: string) {
  // The owner membership and the workspace commit together: a deferred trigger refuses
  // a shared workspace that would have no owner at the end of the statement.
  return database.db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ id: randomUUID(), kind: "shared", name })
      .returning();
    if (workspace === undefined) throw new Error("the workspace was not created");
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: ownerHumanId,
      isOwner: true,
    });
    return workspace;
  });
}

async function membership(workspaceId: string, humanId: string, isOwner = false) {
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId,
    isOwner,
  });
}

async function removeMembership(workspaceId: string, humanId: string) {
  await database.db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    );
}

async function project(workspaceId: string, name: string, createdByHumanId: string) {
  const [row] = await database.db
    .insert(projects)
    .values({ id: randomUUID(), workspaceId, name, createdByHumanId })
    .returning();
  if (row === undefined) throw new Error("the project was not created");
  return row;
}

async function grant(projectId: string, humanId: string, level: "read" | "contribute" | "manage") {
  await database.db.insert(projectAccessGrants).values({
    id: randomUUID(),
    projectId,
    humanId,
    level,
    grantedByHumanId: humanId,
  });
}

async function setGrant(
  projectId: string,
  humanId: string,
  level: "read" | "contribute" | "manage",
) {
  await database.db
    .update(projectAccessGrants)
    .set({ level })
    .where(
      and(eq(projectAccessGrants.projectId, projectId), eq(projectAccessGrants.humanId, humanId)),
    );
}

async function removeGrant(projectId: string, humanId: string) {
  await database.db
    .delete(projectAccessGrants)
    .where(
      and(eq(projectAccessGrants.projectId, projectId), eq(projectAccessGrants.humanId, humanId)),
    );
}

async function makeAgent(app: Hono, cookie: string, name: string) {
  const res = await postJson(app, "/api/agents", { name }, cookie);
  expect(res.status).toBe(201);
  return idOf(await res.json(), "agent");
}

async function issueKey(
  app: Hono,
  cookie: string,
  input: {
    agentId: string;
    workspaceId: string;
    projects: { projectId: string; level: string }[];
    validity?: string;
  },
) {
  const res = await postJson(app, "/api/agents/keys", input, cookie);
  expect(res.status).toBe(201);
  return CreateAgentKeyResponse.parse(await res.json());
}

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
  // Deletes in FK-safe order, matching the other feature tests: workspace_memberships
  // is protected by a trigger and cannot be truncated.
  await database.db.transaction(async (tx) => {
    // Work sessions reference issues and runs; #36's fixture claims one before an agent
    // may edit an issue, so they go before both.
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);
    // Content that now carries an agent actor must go before the agent rows it names.
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);
    // The claim fixture inserts a run; it names the agent, so it goes first.
    await tx.execute(sql`delete from run_children`);
    await tx.execute(sql`delete from run_model_changes`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from workspace_events`);
    await tx.execute(sql`delete from workspace_invitation_grants`);
    await tx.execute(sql`delete from workspace_invitations`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspace_ownership_guards`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from invitations`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from instance_setup`);
    await tx.execute(sql`delete from instance_settings`);
    await tx.execute(sql`delete from email_verification_tokens`);
    await tx.execute(sql`delete from humans`);
  });
});

describe("workspace-scoped agent API keys", () => {
  it("creates an agent, issues a 90-day key by default, and authenticates REST as that agent", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const p = await project(workspace.id, "Personal project", admin.id);

    const agentId = await makeAgent(app, adminCookie, "build-bot");
    const duplicate = await postJson(app, "/api/agents", { name: "build-bot" }, adminCookie);
    await expectProblem(duplicate, 409, "agent_name_taken");
    const issued = await issueKey(app, adminCookie, {
      agentId,
      workspaceId: workspace.id,
      projects: [{ projectId: p.id, level: "manage" }],
    });
    expect(issued.key.validity).toBe("90");
    expect(issued.key.expiresAt).not.toBeNull();
    expect(issued.secret).toMatch(/^orr_ak_/);

    const me = await getJson(app, "/api/agents/me", undefined, issued.secret);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      agentId,
      humanId: admin.id,
      keyId: issued.key.id,
      workspaceId: workspace.id,
      name: "build-bot",
      projects: [{ projectId: p.id, level: "manage" }],
    });

    // Only the hash is stored, and no listing can recover the secret.
    const [stored] = await database.db
      .select({ tokenHash: agentApiKeys.tokenHash })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, issued.key.id));
    expect(stored?.tokenHash).toBe(tokenHash(issued.secret));
    const list = await getJson(app, "/api/agents/keys", adminCookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain(issued.secret);

    const events = await database.db.select().from(agentKeyEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_key_created",
      keyId: issued.key.id,
      agentId,
      workspaceId: workspace.id,
      actorHumanId: admin.id,
    });
    expect(JSON.stringify(events)).not.toContain(issued.secret);
  });

  it("refuses a key used in another workspace or on a project outside its scope", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const other = await sharedWorkspace("Other", admin.id);
    const p = await project(workspace.id, "In scope", admin.id);
    const outside = await project(other.id, "Out of scope", admin.id);
    const agentId = await makeAgent(app, adminCookie, "scoped-bot");
    const issued = await issueKey(app, adminCookie, {
      agentId,
      workspaceId: workspace.id,
      projects: [{ projectId: p.id, level: "read" }],
    });

    const cross = await getJson(
      app,
      `/api/agents/me?workspaceId=${other.id}`,
      undefined,
      issued.secret,
    );
    expect(cross.status).toBe(403);
    await expectProblem(cross, 403, "key_out_of_scope");
    const out = await getJson(
      app,
      `/api/agents/me?projectId=${outside.id}`,
      undefined,
      issued.secret,
    );
    await expectProblem(out, 403, "insufficient_agent_access");

    // A key cannot even be issued with a project from a different workspace.
    const bad = await postJson(
      app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId: outside.id, level: "read" }],
      },
      adminCookie,
    );
    await expectProblem(bad, 400, "invalid_key_grant");
  });

  it("accepts a key just before expiry and refuses it just after, evaluated in database time", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const p = await project(workspace.id, "Timed", admin.id);
    const agentId = await makeAgent(app, adminCookie, "timed-bot");

    const secret = `orr_ak_${randomBytes(32).toString("base64url")}`;
    const [key] = await database.db
      .insert(agentApiKeys)
      .values({
        id: randomUUID(),
        agentId,
        workspaceId: workspace.id,
        createdByHumanId: admin.id,
        validity: "7",
        tokenHash: tokenHash(secret),
        expiresAt: sql`now() + interval '2 seconds'`,
      })
      .returning();
    if (key === undefined) throw new Error("the key was not created");
    await database.db.insert(agentApiKeyProjects).values({
      id: randomUUID(),
      keyId: key.id,
      projectId: p.id,
      level: "read",
    });

    const before = await getJson(app, "/api/agents/me", undefined, secret);
    expect(before.status).toBe(200);

    await database.db
      .update(agentApiKeys)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(agentApiKeys.id, key.id));
    const after = await getJson(app, "/api/agents/me", undefined, secret);
    await expectProblem(after, 401, "key_expired");
  });

  it("enforces the human's level at issue and caps dynamically when it is lowered, including Never", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await sharedWorkspace("Team", admin.id);
    const member = await insertHuman(MEMBER_EMAIL);
    const memberCookie = await createSession(member.id);
    await membership(workspace.id, member.id);
    const p = await project(workspace.id, "Team project", admin.id);
    await grant(p.id, member.id, "contribute");
    const agentId = await makeAgent(app, memberCookie, "member-bot");

    // Issuing above the human's current access is refused, so a later promotion cannot
    // silently raise an old key.
    const tooHigh = await postJson(
      app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: workspace.id,
        validity: "never",
        projects: [{ projectId: p.id, level: "manage" }],
      },
      memberCookie,
    );
    await expectProblem(tooHigh, 400, "invalid_key_grant");

    const issued = await issueKey(app, memberCookie, {
      agentId,
      workspaceId: workspace.id,
      validity: "never",
      projects: [{ projectId: p.id, level: "contribute" }],
    });
    expect(issued.key.validity).toBe("never");
    expect(issued.key.expiresAt).toBeNull();

    let me = await getJson(app, "/api/agents/me?projectId=" + p.id, undefined, issued.secret);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      projects: [{ projectId: p.id, projectName: "Team project", level: "contribute" }],
    });

    // Demotion takes effect on the very next request, without reissuing the key.
    await setGrant(p.id, member.id, "read");
    me = await getJson(app, "/api/agents/me?projectId=" + p.id, undefined, issued.secret);
    expect(await me.json()).toMatchObject({ projects: [{ projectId: p.id, level: "read" }] });

    await removeGrant(p.id, member.id);
    const denied = await getJson(app, "/api/agents/me?projectId=" + p.id, undefined, issued.secret);
    await expectProblem(denied, 403, "insufficient_agent_access");

    // Never skips expiry only: leaving the workspace still stops a Never key immediately.
    await removeMembership(workspace.id, member.id);
    const removed = await getJson(
      app,
      `/api/agents/me?workspaceId=${workspace.id}`,
      undefined,
      issued.secret,
    );
    await expectProblem(removed, 401, "key_workspace_inaccessible");
  });

  it("revokes keys without secrets, and an owner's revocation is isolated to their workspace", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const team = await sharedWorkspace("Team", admin.id);
    const member = await insertHuman(MEMBER_EMAIL);
    const memberCookie = await createSession(member.id);
    await membership(team.id, member.id);
    const memberPersonal = await personalWorkspace(member.id);
    const teamProject = await project(team.id, "Team project", admin.id);
    await grant(teamProject.id, member.id, "read");
    const ownProject = await project(memberPersonal.id, "Private", member.id);

    const memberAgent = await makeAgent(app, memberCookie, "member-bot");
    const teamKey = await issueKey(app, memberCookie, {
      agentId: memberAgent,
      workspaceId: team.id,
      projects: [{ projectId: teamProject.id, level: "read" }],
    });
    const ownKey = await issueKey(app, memberCookie, {
      agentId: memberAgent,
      workspaceId: memberPersonal.id,
      projects: [{ projectId: ownProject.id, level: "manage" }],
    });

    // The owner sees keys in the workspace without any secret, and can revoke one that
    // belongs to another human.
    const listed = await getJson(app, `/api/workspaces/${team.id}/agent-keys`, adminCookie);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(JSON.stringify(listedBody)).toContain(teamKey.key.id);
    expect(JSON.stringify(listedBody)).toContain(teamKey.key.agentName);
    expect(JSON.stringify(listedBody)).toContain(teamKey.key.projects[0]?.projectName ?? "");
    expect(JSON.stringify(listedBody)).not.toContain(teamKey.secret);
    expect(JSON.stringify(listedBody)).not.toContain(ownKey.secret);

    const ownerRevoke = await deleteRequest(
      app,
      `/api/workspaces/${team.id}/agent-keys/${teamKey.key.id}`,
      adminCookie,
    );
    expect(ownerRevoke.status).toBe(204);
    // A retry is idempotent: it answers 204 but writes no second revocation event.
    const repeatOwnerRevoke = await deleteRequest(
      app,
      `/api/workspaces/${team.id}/agent-keys/${teamKey.key.id}`,
      adminCookie,
    );
    expect(repeatOwnerRevoke.status).toBe(204);

    // The revoked key fails; the human's key in another workspace still works.
    const refused = await getJson(app, "/api/agents/me", undefined, teamKey.secret);
    await expectProblem(refused, 401, "key_revoked");
    const unaffected = await getJson(app, "/api/agents/me", undefined, ownKey.secret);
    expect(unaffected.status).toBe(200);

    // The owner cannot reach a key outside their workspace at all.
    const elsewhere = await deleteRequest(
      app,
      `/api/workspaces/${team.id}/agent-keys/${ownKey.key.id}`,
      adminCookie,
    );
    await expectProblem(elsewhere, 404, "key_not_found");

    // The human can revoke their own remaining key.
    const ownRevoke = await deleteRequest(app, `/api/agents/keys/${ownKey.key.id}`, memberCookie);
    expect(ownRevoke.status).toBe(204);
    const repeatOwnRevoke = await deleteRequest(
      app,
      `/api/agents/keys/${ownKey.key.id}`,
      memberCookie,
    );
    expect(repeatOwnRevoke.status).toBe(204);
    await expectProblem(
      await getJson(app, "/api/agents/me", undefined, ownKey.secret),
      401,
      "key_revoked",
    );

    const events = await database.db.select().from(agentKeyEvents);
    expect(events).toHaveLength(4);
    expect(events.filter((event) => event.type === "agent_key_created")).toHaveLength(2);
    expect(events.filter((event) => event.type === "agent_key_revoked")).toHaveLength(2);
    expect(
      events.find((event) => event.keyId === teamKey.key.id && event.type === "agent_key_revoked"),
    ).toMatchObject({
      actorHumanId: admin.id,
      workspaceId: team.id,
    });
    for (const event of events) expect(JSON.stringify(event)).not.toContain(teamKey.secret);
  });

  it("refuses a key project grant from another workspace at the database", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const other = await sharedWorkspace("Other", admin.id);
    const inScope = await project(workspace.id, "In scope", admin.id);
    const outside = await project(other.id, "Out of scope", admin.id);
    const agentId = await makeAgent(app, adminCookie, "scope-bot");
    const issued = await issueKey(app, adminCookie, {
      agentId,
      workspaceId: workspace.id,
      projects: [{ projectId: inScope.id, level: "read" }],
    });

    // A writer that bypasses the service cannot bind a key to a project in another
    // workspace: the trigger is the database-level second line of defence.
    const error = await rejection(
      database.db.insert(agentApiKeyProjects).values({
        id: randomUUID(),
        keyId: issued.key.id,
        projectId: outside.id,
        level: "read",
      }),
    );
    expect(rootCause(error)?.message ?? String(error)).toContain("agent_key_project_workspace");
    expect(
      await database.db
        .select()
        .from(agentApiKeyProjects)
        .where(eq(agentApiKeyProjects.keyId, issued.key.id)),
    ).toHaveLength(1);
  });

  describe("agent project work (issue #33)", () => {
    it("registers only project-work tools, never membership or administration", () => {
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_projects",
          "get_project",
          "list_issues",
          "get_issue",
          "create_issue",
          "update_issue",
          "list_comments",
          "create_comment",
          "list_activity",
          "list_knowledge",
          "get_knowledge",
          "create_knowledge",
          "update_knowledge",
        ]),
      );
      for (const name of names) {
        expect(name).not.toMatch(/member|invit|workspace|setting|access|key|admin|grant/);
      }
    });

    it("attributes a Contribute agent's writes to the agent, not its human owner", async () => {
      const { app, projects: projectsService, sessions } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const workspace = await personalWorkspaceOf(admin);
      const created = await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "Agent work" },
        cookie,
      );
      expect(created.status).toBe(201);
      const projectId = idOf(await created.json(), "project");
      const agentId = await makeAgent(app, cookie, "writer-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId, level: "contribute" }],
      });
      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };

      const issue = await projectsService.createIssue(actor, projectId, {
        title: "Agent issue",
        body: "body",
      });
      expect(issue.createdBy).toMatchObject({
        agentId,
        agentName: identity.name,
        displayName: identity.name,
      });
      expect(issue.createdBy.humanId).toBeFalsy();
      // An agent's issue edit, close and reopen require a live session it holds (#36).
      await claimIssue(sessions, identity, issue.id);
      const editedIssue = await projectsService.updateIssue(actor, issue.id, {
        title: "Edited by the agent",
        body: "New **body** by the agent.",
      });
      expect(editedIssue).toMatchObject({
        title: "Edited by the agent",
        body: "New **body** by the agent.",
      });
      expect(editedIssue.updatedBy).toMatchObject({ agentId });
      const closed = await projectsService.updateIssue(actor, issue.id, { status: "closed" });
      expect(closed.updatedBy).toMatchObject({ agentId });
      const reopened = await projectsService.updateIssue(actor, issue.id, { status: "open" });
      expect(reopened).toMatchObject({ status: "open", closedAt: null });
      expect(reopened.updatedBy).toMatchObject({ agentId });
      const comment = await projectsService.createComment(actor, issue.id, {
        body: "Agent comment",
      });
      expect(comment.author).toMatchObject({ agentId });
      const entry = await projectsService.createKnowledge(actor, projectId, {
        title: "Agent note",
      });
      expect(entry.createdBy).toMatchObject({ agentId });
      const edited = await projectsService.updateKnowledge(actor, entry.id, { body: "more" });
      expect(edited.updatedBy).toMatchObject({ agentId });

      const [issueRow] = await database.db.select().from(issues).where(eq(issues.id, issue.id));
      expect(issueRow).toMatchObject({
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
        createdByHumanId: null,
        updatedByHumanId: null,
      });
      const [commentRow] = await database.db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, comment.id));
      expect(commentRow).toMatchObject({ createdByAgentId: agentId, createdByHumanId: null });
      const [entryRow] = await database.db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, entry.id));
      expect(entryRow).toMatchObject({
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
        createdByHumanId: null,
        updatedByHumanId: null,
      });

      const activities = await database.db.select().from(projectActivity);
      expect(activities.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "issue_created",
          "issue_edited",
          "issue_closed",
          "issue_reopened",
          "issue_commented",
          "knowledge_created",
          "knowledge_edited",
        ]),
      );
      const agentEvents = activities.filter((event) => event.type !== "project_created");
      expect(agentEvents).not.toHaveLength(0);
      for (const event of agentEvents) {
        expect(event).toMatchObject({ actorAgentId: agentId, actorHumanId: null });
      }
      const feed = await projectsService.listActivity(actor, projectId);
      const agentFeed = feed.filter((event) => event.type !== "project_created");
      expect(agentFeed).not.toHaveLength(0);
      for (const event of agentFeed) expect(event.actor).toMatchObject({ agentId });
    });

    it("lets a Read key inspect but not change work, matching REST human Read denials", async () => {
      const { app, projects: projectsService } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const workspace = await sharedWorkspace("Read team", admin);
      const created = await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "Read only" },
        cookie,
      );
      expect(created.status).toBe(201);
      const projectId = idOf(await created.json(), "project");
      const humanIssue = await projectsService.createIssue(
        humanActor(admin, ADMIN_EMAIL),
        projectId,
        { title: "Existing issue" },
      );

      const agentId = await makeAgent(app, cookie, "reader-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId, level: "read" }],
      });
      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };

      // Inspection through the same service the MCP tools call succeeds.
      expect(await projectsService.listProjects(actor, workspace.id)).toHaveLength(1);
      expect((await projectsService.getProject(actor, projectId)).id).toBe(projectId);
      expect(await projectsService.listIssues(actor, projectId)).toHaveLength(1);
      expect((await projectsService.getIssue(actor, humanIssue.id)).id).toBe(humanIssue.id);
      expect(await projectsService.listComments(actor, humanIssue.id)).toEqual([]);
      expect(await projectsService.listActivity(actor, projectId)).not.toHaveLength(0);
      expect(await projectsService.listKnowledge(actor, projectId)).toEqual([]);

      const denials = await Promise.all([
        rejection(projectsService.createIssue(actor, projectId, { title: "No" })),
        rejection(projectsService.updateIssue(actor, humanIssue.id, { status: "closed" })),
        rejection(projectsService.createComment(actor, humanIssue.id, { body: "No" })),
        rejection(projectsService.createKnowledge(actor, projectId, { title: "No" })),
      ]);
      for (const error of denials) expectProjectsError(error, "insufficient_project_access");

      // The equivalent human Read denial over REST has the same stable code. A bearer
      // key is never accepted by the human REST routes at all.
      const other = await insertHuman("rest-reader@example.com");
      const memberCookie = await createSession(other.id);
      await membership(workspace.id, other.id);
      await grant(projectId, other.id, "read");
      const restDenied = await patchJson(
        app,
        `/api/issues/${humanIssue.id}`,
        { status: "closed" },
        memberCookie,
      );
      await expectProblem(restDenied, 403, "insufficient_project_access");
      const bearerOnly = await patchJson(app, `/api/issues/${humanIssue.id}`, { status: "closed" });
      expect(bearerOnly.status).toBe(401);
    });

    it("refuses cross-workspace and out-of-scope project work", async () => {
      const { app, projects: projectsService } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const workspace = await personalWorkspaceOf(admin);
      const scoped = await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "Scoped" },
        cookie,
      );
      const scopedId = idOf(await scoped.json(), "project");
      expect(scopedId).toBeTruthy();
      const otherWorkspace = await sharedWorkspace("Other", admin);
      const otherProject = await project(otherWorkspace.id, "Other project", admin);
      const otherIssue = await projectsService.createIssue(
        humanActor(admin, ADMIN_EMAIL),
        otherProject.id,
        { title: "Other issue" },
      );

      const agentId = await makeAgent(app, cookie, "scoped-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId: scopedId, level: "contribute" }],
      });
      const namedOther = await getJson(
        app,
        `/api/agents/me?projectId=${otherProject.id}`,
        undefined,
        key.secret,
      );
      await expectProblem(namedOther, 403, "insufficient_agent_access");
      const namedOtherWorkspace = await getJson(
        app,
        `/api/agents/me?workspaceId=${otherWorkspace.id}`,
        undefined,
        key.secret,
      );
      await expectProblem(namedOtherWorkspace, 403, "key_out_of_scope");

      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };
      expectProjectsError(
        await rejection(projectsService.getIssue(actor, otherIssue.id)),
        "issue_not_found",
      );
      expectProjectsError(
        await rejection(projectsService.createIssue(actor, otherProject.id, { title: "No" })),
        "project_not_found",
      );
    });

    it("refuses a list_projects request aimed at another workspace the owner belongs to", async () => {
      const { app, projects: projectsService } = await makeBearerApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const scopedWorkspace = await personalWorkspaceOf(admin);
      // Workspace B is one the key's human owner is a member of (its owner), so a
      // membership oracle would answer 200 here instead of denying the out-of-scope key.
      const otherWorkspace = await sharedWorkspace("Other owned team", admin);
      const created = await postJson(
        app,
        `/api/workspaces/${scopedWorkspace.id}/projects`,
        { name: "Scoped" },
        cookie,
      );
      const projectId = idOf(await created.json(), "project");
      const agentId = await makeAgent(app, cookie, "list-scoped-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: scopedWorkspace.id,
        projects: [{ projectId, level: "read" }],
      });
      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };

      expectProjectsError(
        await rejection(projectsService.listProjects(actor, otherWorkspace.id)),
        "workspace_not_found",
      );
      // The same denial over REST, with the same bearer key.
      const rest = await getJson(
        app,
        `/api/workspaces/${otherWorkspace.id}/projects`,
        undefined,
        key.secret,
      );
      await expectProblem(rest, 404, "workspace_not_found");
      // Sanity: the in-scope listing still works.
      const inScope = await getJson(
        app,
        `/api/workspaces/${scopedWorkspace.id}/projects`,
        undefined,
        key.secret,
      );
      expect(inScope.status).toBe(200);
    });

    it("caps an agent by its owner's current human access and ends access on removal", async () => {
      const { app, projects: projectsService } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const team = await sharedWorkspace("Team", admin);
      const created = await postJson(
        app,
        `/api/workspaces/${team.id}/projects`,
        { name: "Shared work" },
        adminCookie,
      );
      expect(created.status).toBe(201);
      const projectId = idOf(await created.json(), "project");

      const member = await insertHuman(MEMBER_EMAIL);
      const memberCookie = await createSession(member.id);
      await membership(team.id, member.id);
      await grant(projectId, member.id, "contribute");
      const agentId = await makeAgent(app, memberCookie, "team-bot");
      const key = await issueKey(app, memberCookie, {
        agentId,
        workspaceId: team.id,
        projects: [{ projectId, level: "contribute" }],
      });

      let identity = await identityFor(app, key.secret);
      expect(identity.projects).toMatchObject([{ projectId, level: "contribute" }]);
      let actor = { kind: "agent" as const, identity };
      const issue = await projectsService.createIssue(actor, projectId, {
        title: "Before demotion",
      });
      expect(issue.id).toBeTruthy();

      // A dynamic human-access demotion caps the key on its very next request.
      await setGrant(projectId, member.id, "read");
      identity = await identityFor(app, key.secret);
      expect(identity.projects).toMatchObject([{ projectId, level: "read" }]);
      actor = { kind: "agent" as const, identity };
      expectProjectsError(
        await rejection(projectsService.updateIssue(actor, issue.id, { title: "After demotion" })),
        "insufficient_project_access",
      );
      expect((await projectsService.listIssues(actor, projectId)).length).toBe(1);

      // Removing the workspace member ends every key they own immediately. The real
      // removal endpoint also revokes their project grants in the same transaction; this
      // test deletes the membership directly, so mirror that cleanup here.
      await removeMembership(team.id, member.id);
      await removeGrant(projectId, member.id);
      await expectProblem(
        await getJson(app, "/api/agents/me", undefined, key.secret),
        401,
        "key_workspace_inaccessible",
      );

      // Rejoining starts fresh: the old grant does not silently return.
      await membership(team.id, member.id);
      const rejoined = await identityFor(app, key.secret);
      expect(rejoined.projects).toEqual([]);
      expectProjectsError(
        await rejection(
          projectsService.createIssue({ kind: "agent", identity: rejoined }, projectId, {
            title: "No",
          }),
        ),
        "project_not_found",
      );

      // Revocation is independent of membership and takes effect on the next call.
      const revoked = await deleteRequest(app, `/api/agents/keys/${key.key.id}`, memberCookie);
      expect(revoked.status).toBe(204);
      await expectProblem(
        await getJson(app, "/api/agents/me", undefined, key.secret),
        401,
        "key_revoked",
      );
    });
  });
});
