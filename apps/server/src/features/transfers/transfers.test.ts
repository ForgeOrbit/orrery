import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AgentIdentity,
  CreateAgentKeyResponse,
  Problem,
  Project,
  TransferAuthorization,
  TransferPreview,
} from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  browserSessions,
  humans,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projectTransferAuthorizations,
  projects,
  runs,
  workSessions,
  workspaceEvents,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createAgentsFeature, type AgentAuthenticator } from "../agents/index.ts";
import { createProjectsFeature, type WorkSessionGate } from "../projects/index.ts";
import { createSessionsFeature, type SessionsService } from "../work-sessions/index.ts";
import { createWorkspacesFeature } from "../workspaces/index.ts";
import { createTransfersFeature } from "./index.ts";

// Real Postgres (AGENTS.md): transfer authority rechecks, the database-time live-work
// gate, lock ordering, key/grant cleanup and event placement are database behavior.
// The REST seam is the public interface; zz-transfer.spec.ts repeats the flow black-box.

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "transfer-admin@example.com";
const ADMIN_PASSWORD = "transfer-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let sessionsService: SessionsService;

const postJson = (path: string, body: unknown, cookie?: string, bearer?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getJson = (path: string, cookie?: string, bearer?: string) =>
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

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what} id`);
  return id;
}

function stringsOf(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => {
    const fieldValue = field(item, key);
    return typeof fieldValue === "string" ? [fieldValue] : [];
  });
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

async function cookieFor(email: string, password: string) {
  const res = await postJson("/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie");
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
  if (human === undefined) throw new Error("the account was not created");
  return human;
}

async function sessionFor(humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    expiresAt: sql`now() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

async function personalWorkspaceId(humanId: string) {
  const [workspace] = await database.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("no personal workspace");
  return workspace.id;
}

async function createSharedWorkspace(cookie: string, name: string, email: string) {
  const res = await postJson("/api/workspaces", { name }, cookie);
  expect(res.status).toBe(201);
  const [row] = await database.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.name, name), eq(workspaces.kind, "shared")));
  if (row === undefined) throw new Error("the destination workspace was not created");
  return { workspaceId: row.id, ownerEmail: email };
}

async function addMembership(workspaceId: string, humanId: string, canCreateProjects = false) {
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId,
    isOwner: false,
    canCreateProjects,
  });
}

async function createPersonalProject(cookie: string, workspaceId: string, name: string) {
  const res = await postJson(`/api/workspaces/${workspaceId}/projects`, { name }, cookie);
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createIssue(cookie: string, projectId: string, title: string) {
  const res = await postJson(`/api/projects/${projectId}/issues`, { title }, cookie);
  expect(res.status).toBe(201);
  return idOf(await res.json(), "issue");
}

async function issueKey(cookie: string, workspaceId: string, projectId: string) {
  const agentName = `transfer-agent-${randomUUID()}`;
  const agentRes = await postJson("/api/agents", { name: agentName }, cookie);
  expect(agentRes.status).toBe(201);
  const keyRes = await postJson(
    "/api/agents/keys",
    {
      agentId: idOf(await agentRes.json(), "agent"),
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
    cookie,
  );
  expect(keyRes.status).toBe(201);
  return CreateAgentKeyResponse.parse(await keyRes.json()).secret;
}

async function identityFor(secret: string) {
  const res = await getJson("/api/agents/me", undefined, secret);
  expect(res.status).toBe(200);
  return AgentIdentity.parse(await res.json());
}

async function claimIssue(secret: string, issueId: string) {
  const identity = await identityFor(secret);
  const [run] = await database.db
    .insert(runs)
    .values({
      id: randomUUID(),
      agentId: identity.agentId,
      workspaceId: identity.workspaceId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: runs.id });
  if (run === undefined) throw new Error("the run was not created");
  return sessionsService.claim({ kind: "agent", identity }, { issueId, runId: run.id });
}

async function preview(cookie: string, projectId: string, destinationWorkspaceId: string) {
  const res = await postJson(
    `/api/projects/${projectId}/transfer/preview`,
    { destinationWorkspaceId },
    cookie,
  );
  expect(res.status).toBe(200);
  return TransferPreview.parse(await res.json());
}

async function authorize(cookie: string, projectId: string, destinationWorkspaceId: string) {
  const res = await postJson(
    `/api/projects/${projectId}/transfer`,
    { destinationWorkspaceId },
    cookie,
  );
  expect(res.status).toBe(201);
  return TransferAuthorization.parse(await res.json());
}

async function receiverPreview(cookie: string, token: string) {
  const res = await postJson("/api/transfers/preview", { token }, cookie);
  expect(res.status).toBe(200);
  return TransferPreview.parse(await res.json());
}

async function accept(cookie: string, token: string) {
  return postJson("/api/transfers/accept", { token }, cookie);
}

async function complete(cookie: string, projectId: string, destinationWorkspaceId: string) {
  return postJson(
    `/api/projects/${projectId}/transfer/complete`,
    { destinationWorkspaceId },
    cookie,
  );
}

async function getProject(cookie: string, projectId: string) {
  const res = await getJson(`/api/projects/${projectId}`, cookie);
  expect(res.status).toBe(200);
  return Project.parse(await res.json());
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

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
      if (gate === undefined) throw new Error("session gate is not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
  });
  let liveAuthenticator: AgentAuthenticator | undefined;
  const lateAuth: AgentAuthenticator = (request) => {
    if (liveAuthenticator === undefined) throw new Error("authenticator is not wired");
    return liveAuthenticator(request);
  };
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
  });
  liveAuthenticator = agentsFeature.authenticator;
  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
    listIssues: (actor, projectId) => projectsFeature.service.listIssues(actor, projectId),
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  sessionsService = sessionsFeature.service;
  const workspacesFeature = createWorkspacesFeature({
    db: database.db,
    publicUrl: PUBLIC_URL,
    sessionReader: accounts.sessionReader,
    createInvitedHuman: accounts.createInvitedHuman,
    markEmailVerified: accounts.markEmailVerified,
    deliver: async () => {},
    log: silentLogger,
    revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
      projectsFeature.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
    revokeMemberWorkspaceKeys: async () => {},
    applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
      projectsFeature.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
  });
  const transfersFeature = createTransfersFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
  });
  app = createApp({
    features: [
      accounts,
      projectsFeature,
      agentsFeature,
      sessionsFeature,
      workspacesFeature,
      transfersFeature,
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
}, 120_000);

beforeEach(async () => {
  // afterEach wipes the installation, so each test starts from a freshly bootstrapped
  // first administrator and their personal workspace.
  const [admin] = await database.db
    .select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL));
  if (admin !== undefined) return;
  const setup = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (setup.status !== 201) throw new Error("bootstrap did not create the first administrator");
});

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from project_transfer_authorizations`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from run_children`);
    await tx.execute(sql`delete from run_model_changes`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from workspace_invitation_grants`);
    await tx.execute(sql`delete from workspace_invitations`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from workspace_events`);
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

async function source() {
  const cookie = await cookieFor(ADMIN_EMAIL, ADMIN_PASSWORD);
  const [admin] = await database.db
    .select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL));
  if (admin === undefined) throw new Error("no admin");
  const workspaceId = await personalWorkspaceId(admin.id);
  const project = await createPersonalProject(cookie, workspaceId, "Personal project");
  return { cookie, humanId: admin.id, workspaceId, project };
}

describe("personal-to-shared project transfer against real Postgres", () => {
  it("previews destination, visibility, access changes and active work without writing", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Preview Team", ADMIN_EMAIL);
    const issueId = await createIssue(s.cookie, s.project.id, "Preview issue");
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    await claimIssue(secret, issueId);

    const result = await preview(s.cookie, s.project.id, dest.workspaceId);
    expect(result).toMatchObject({
      projectId: s.project.id,
      visibilityChange: "personal_to_shared",
      source: { workspaceId: s.workspaceId, kind: "personal" },
      destination: { workspaceId: dest.workspaceId, kind: "shared" },
      revokedSourceGrants: 0,
      ready: false,
    });
    expect(result.activeWork.count).toBe(1);
    expect(result.activeWork.issues[0]).toMatchObject({ issueId, title: "Preview issue" });
    expect(result.accessChanges).toEqual([
      expect.objectContaining({ reason: "destination_owner", level: "manage" }),
    ]);
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(0);
  });

  it("blocks a claim made between authorization and acceptance, then allows it after the claim stops", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Busy Team", ADMIN_EMAIL);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);

    const issueId = await createIssue(s.cookie, s.project.id, "Claimed after authorization");
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    const session = await claimIssue(secret, issueId);

    await expectProblem(await accept(s.cookie, authorization.token), 409, "active_work");
    expect((await getProject(s.cookie, s.project.id)).workspaceId).toBe(s.workspaceId);

    await sessionsService.stop(
      { kind: "agent", identity: await identityFor(secret) },
      issueId,
      "completed",
    );
    const res = await accept(s.cookie, authorization.token);
    expect(res.status).toBe(200);
    expect(await getProject(s.cookie, s.project.id)).toMatchObject({
      workspaceId: dest.workspaceId,
    });
    expect(session.status).toBe("active");
  });

  it("does not let an expired claim in database time block acceptance", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Stale Team", ADMIN_EMAIL);
    const issueId = await createIssue(s.cookie, s.project.id, "Stale issue");
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    await claimIssue(secret, issueId);
    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 second' where issue_id = ${issueId} and status = 'active'`,
    );
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    const res = await accept(s.cookie, authorization.token);
    expect(res.status).toBe(200);
    const sessions = await database.db
      .select({ status: workSessions.status })
      .from(workSessions)
      .where(eq(workSessions.issueId, issueId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("expired");
  });

  it("completes directly when one person owns both sides", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Direct Team", ADMIN_EMAIL);
    const res = await complete(s.cookie, s.project.id, dest.workspaceId);
    expect(res.status).toBe(200);
    expect(await getProject(s.cookie, s.project.id)).toMatchObject({
      id: s.project.id,
      workspaceId: dest.workspaceId,
      workspaceKind: "shared",
      accessLevel: "manage",
    });
  });

  it("supports two parties: source owner authorizes, a Create projects member accepts", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Two Party Team", ADMIN_EMAIL);
    const receiver = await insertHuman("receiver@example.com");
    await addMembership(dest.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    expect(authorization.authorizedByHumanId).toBe(s.humanId);
    const res = await accept(receiverCookie, authorization.token);
    expect(res.status).toBe(200);
    expect(await getProject(receiverCookie, s.project.id)).toMatchObject({
      workspaceId: dest.workspaceId,
      accessLevel: "manage",
    });

    const grants = await database.db
      .select({ humanId: projectAccessGrants.humanId, level: projectAccessGrants.level })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, s.project.id));
    expect(grants).toEqual(
      expect.arrayContaining([expect.objectContaining({ humanId: receiver.id, level: "manage" })]),
    );
  });

  it("supports two parties when the destination owner is different from the source owner", async () => {
    const s = await source();
    const destinationOwner = await insertHuman("dest-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const dest = await createSharedWorkspace(ownerCookie, "Owner Team", "dest-owner@example.com");

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    const res = await accept(ownerCookie, authorization.token);
    expect(res.status).toBe(200);
    expect(await getProject(ownerCookie, s.project.id)).toMatchObject({ accessLevel: "manage" });
  });

  it("refuses acceptance when the project workspace changed after authorization", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Changed Team", ADMIN_EMAIL);
    const other = await createSharedWorkspace(s.cookie, "Other Team", ADMIN_EMAIL);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await database.db
      .update(projects)
      .set({ workspaceId: other.workspaceId })
      .where(eq(projects.id, s.project.id));
    await expectProblem(await accept(s.cookie, authorization.token), 409, "transfer_stale");
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("refuses acceptance when destination authority was withdrawn", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Authority Team", ADMIN_EMAIL);
    const receiver = await insertHuman("downgraded@example.com");
    await addMembership(dest.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await database.db
      .update(workspaceMemberships)
      .set({ canCreateProjects: false })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, dest.workspaceId),
          eq(workspaceMemberships.humanId, receiver.id),
        ),
      );
    await expectProblem(
      await accept(receiverCookie, authorization.token),
      403,
      "destination_authority_required",
    );
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("refuses acceptance when the authorizing owner lost the source", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Lost Source Team", ADMIN_EMAIL);
    const successor = await insertHuman("successor@example.com");
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await database.db
      .update(workspaces)
      .set({ personalOwnerHumanId: successor.id })
      .where(eq(workspaces.id, s.workspaceId));
    await expectProblem(await accept(s.cookie, authorization.token), 409, "source_authority_lost");
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("removes the project from source keys, rebuilds Manage and preserves identity and history", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "History Team", ADMIN_EMAIL);
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    const issueId = await createIssue(s.cookie, s.project.id, "Preserved issue");
    const beforeActivity = await getJson(`/api/projects/${s.project.id}/activity`, s.cookie);
    expect(beforeActivity.status).toBe(200);
    expect(stringsOf(await beforeActivity.json(), "type")).toContain("issue_created");

    const res = await complete(s.cookie, s.project.id, dest.workspaceId);
    expect(res.status).toBe(200);

    // Source keys no longer see the moved project.
    const identity = await identityFor(secret);
    expect(identity.projects.map((grant) => grant.projectId)).not.toContain(s.project.id);
    expect(await database.db.select().from(agentApiKeyProjects)).toHaveLength(0);
    const refused = await postJson(
      `/api/projects/${s.project.id}/issues`,
      { title: "Refused" },
      undefined,
      secret,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // Identity and authored history survive the move.
    const after = await getProject(s.cookie, s.project.id);
    expect(after).toMatchObject({
      id: s.project.id,
      name: s.project.name,
      createdBy: { humanId: s.humanId },
      workspaceId: dest.workspaceId,
    });
    const issuesRes = await getJson(`/api/projects/${s.project.id}/issues`, s.cookie);
    expect(issuesRes.status).toBe(200);
    expect(stringsOf(await issuesRes.json(), "id")).toContain(issueId);
    const afterActivity = await getJson(`/api/projects/${s.project.id}/activity`, s.cookie);
    expect(stringsOf(await afterActivity.json(), "type")).toContain("issue_created");
    expect(await database.db.select().from(projectActivity)).not.toHaveLength(0);

    // Destination owners and the receiver hold Manage; receipt and grant events are its own.
    const grants = await database.db
      .select({ level: projectAccessGrants.level })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, s.project.id));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.level === "manage")).toBe(true);
    const accessEvents = await database.db
      .select({ type: projectAccessEvents.type })
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.projectId, s.project.id));
    expect(accessEvents.every((event) => event.type === "project_access_granted")).toBe(true);
    const received = await database.db
      .select({ type: workspaceEvents.type })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, dest.workspaceId));
    expect(received.map((event) => event.type)).toContain("project_transfer_received");
    const sourceEvents = await database.db
      .select({ type: workspaceEvents.type })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, s.workspaceId));
    expect(sourceEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["project_transfer_authorized", "project_transferred_out"]),
    );
  });

  it("invalidates a pending invitation offer for the project on acceptance", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Offer Team", ADMIN_EMAIL);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    // A shared-to-shared move (#46) can leave real offers behind; for a personal project
    // the API cannot create one, so place the offer directly and prove the generic cleanup.
    const [invitation] = await database.db
      .insert(workspaceInvitations)
      .values({
        id: randomUUID(),
        workspaceId: dest.workspaceId,
        email: `offered-${randomUUID()}@example.com`,
        status: "pending",
        tokenHash: randomBytes(32).toString("base64url"),
        invitedByHumanId: s.humanId,
        expiresAt: sql`statement_timestamp() + interval '7 days'`,
      })
      .returning();
    if (invitation === undefined) throw new Error("the invitation was not created");
    await database.db.insert(workspaceInvitationGrants).values({
      id: randomUUID(),
      invitationId: invitation.id,
      projectId: s.project.id,
      level: "read",
    });
    expect(
      await database.db
        .select()
        .from(workspaceInvitationGrants)
        .where(eq(workspaceInvitationGrants.projectId, s.project.id)),
    ).toHaveLength(1);

    const res = await accept(s.cookie, authorization.token);
    expect(res.status).toBe(200);
    expect(
      await database.db
        .select()
        .from(workspaceInvitationGrants)
        .where(eq(workspaceInvitationGrants.projectId, s.project.id)),
    ).toHaveLength(0);
  });

  it("does not enumerate a destination the caller is not a member of", async () => {
    const s = await source();
    const destinationOwner = await insertHuman("hidden-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const dest = await createSharedWorkspace(
      ownerCookie,
      "Hidden Team",
      "hidden-owner@example.com",
    );
    const outsider = await insertHuman("outsider@example.com");
    const outsiderCookie = await sessionFor(outsider.id);

    await expectProblem(
      await postJson(
        `/api/projects/${s.project.id}/transfer/preview`,
        { destinationWorkspaceId: dest.workspaceId },
        s.cookie,
      ),
      404,
      "workspace_not_found",
    );
    await expectProblem(
      await complete(s.cookie, s.project.id, dest.workspaceId),
      404,
      "workspace_not_found",
    );

    // The authorizer is not a destination member either, so the receiver must be one.
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await expectProblem(
      await postJson("/api/transfers/preview", { token: authorization.token }, outsiderCookie),
      404,
      "transfer_invalid",
    );
    await expectProblem(await accept(outsiderCookie, authorization.token), 404, "transfer_invalid");
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("leaks no destination name or owner identities to a non-member authorizer", async () => {
    const s = await source();
    const destinationOwner = await insertHuman("private-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const dest = await createSharedWorkspace(
      ownerCookie,
      "Private Team Name",
      "private-owner@example.com",
    );

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    expect(authorization.preview).toBeNull();
    expect(JSON.stringify(authorization)).not.toContain("private-owner@example.com");
    expect(JSON.stringify(authorization)).not.toContain("Private Team Name");
  });

  it("lets a separate Create projects member preview the pending transfer before accepting", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Receiver Team", ADMIN_EMAIL);
    const receiver = await insertHuman("preview-receiver@example.com");
    await addMembership(dest.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);
    const member = await insertHuman("plain-member@example.com");
    await addMembership(dest.workspaceId, member.id, false);
    const memberCookie = await sessionFor(member.id);

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    const view = await receiverPreview(receiverCookie, authorization.token);
    expect(view).toMatchObject({
      projectId: s.project.id,
      destination: { workspaceId: dest.workspaceId },
      visibilityChange: "personal_to_shared",
    });
    expect(view.accessChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanId: s.humanId,
          reason: "destination_owner",
          level: "manage",
        }),
        expect.objectContaining({ humanId: receiver.id, reason: "receiver", level: "manage" }),
      ]),
    );
    await expectProblem(
      await postJson("/api/transfers/preview", { token: authorization.token }, memberCookie),
      403,
      "destination_authority_required",
    );
    const res = await accept(receiverCookie, authorization.token);
    expect(res.status).toBe(200);
  });

  it("keeps settled invitation offers and revokes sibling authorization tokens", async () => {
    const s = await source();
    const first = await createSharedWorkspace(s.cookie, "Destination First", ADMIN_EMAIL);
    const second = await createSharedWorkspace(s.cookie, "Destination Second", ADMIN_EMAIL);
    const firstAuth = await authorize(s.cookie, s.project.id, first.workspaceId);
    const secondAuth = await authorize(s.cookie, s.project.id, second.workspaceId);

    const [settled] = await database.db
      .insert(workspaceInvitations)
      .values({
        id: randomUUID(),
        workspaceId: first.workspaceId,
        email: `settled-${randomUUID()}@example.com`,
        status: "accepted",
        tokenHash: randomBytes(32).toString("base64url"),
        invitedByHumanId: s.humanId,
        expiresAt: sql`statement_timestamp() + interval '7 days'`,
      })
      .returning();
    const [pending] = await database.db
      .insert(workspaceInvitations)
      .values({
        id: randomUUID(),
        workspaceId: first.workspaceId,
        email: `pending-${randomUUID()}@example.com`,
        status: "pending",
        tokenHash: randomBytes(32).toString("base64url"),
        invitedByHumanId: s.humanId,
        expiresAt: sql`statement_timestamp() + interval '7 days'`,
      })
      .returning();
    if (settled === undefined || pending === undefined) throw new Error("invitations not created");
    await database.db.insert(workspaceInvitationGrants).values([
      { id: randomUUID(), invitationId: settled.id, projectId: s.project.id, level: "read" },
      { id: randomUUID(), invitationId: pending.id, projectId: s.project.id, level: "read" },
    ]);

    const res = await accept(s.cookie, firstAuth.token);
    expect(res.status).toBe(200);
    const remaining = await database.db
      .select({ invitationId: workspaceInvitationGrants.invitationId })
      .from(workspaceInvitationGrants)
      .where(eq(workspaceInvitationGrants.projectId, s.project.id));
    expect(remaining.map((row) => row.invitationId)).toEqual([settled.id]);

    const authorizations = await database.db
      .select({
        id: projectTransferAuthorizations.id,
        status: projectTransferAuthorizations.status,
      })
      .from(projectTransferAuthorizations)
      .where(eq(projectTransferAuthorizations.projectId, s.project.id));
    expect(authorizations.find((row) => row.id === firstAuth.authorizationId)?.status).toBe(
      "accepted",
    );
    expect(authorizations.find((row) => row.id === secondAuth.authorizationId)?.status).toBe(
      "revoked",
    );
  });
});
