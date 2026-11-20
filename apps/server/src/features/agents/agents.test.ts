import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { CreateAgentKeyResponse, Problem } from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature } from "../projects/index.ts";
import { createAgentsFeature } from "./index.ts";

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
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
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
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);
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
});
