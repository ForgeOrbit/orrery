import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Problem,
  Project,
  ProjectAccessGrant,
  ProjectAccessGrantsResponse,
  ProjectsResponse,
  Workspace,
  WorkspaceMember,
  WorkspaceMembersResponse,
} from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  browserSessions,
  humans,
  projectAccessEvents,
  projectAccessGrants,
  workspaceEvents,
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
import { createWorkspacesFeature } from "../workspaces/index.ts";
import { createProjectsFeature } from "./index.ts";

// Runs against a real Postgres (see AGENTS.md): project levels, grant rows, access
// events, membership removal, and the database's scope trigger are database behavior.
// The REST seam is the public interface; the black-box e2e suite repeats the matrix
// against the built server and real browser.

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const MEMBER_EMAIL = "member@example.com";
const COLLEAGUE_EMAIL = "colleague@example.com";
const OUTSIDER_EMAIL = "outsider@example.com";
const PUBLIC_URL = "http://orrery.test";

const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const patchJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const deleteRequest = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const problemBody = async (res: Response) => Problem.parse(await res.json());

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(await problemBody(res)).toMatchObject({ status, code });
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

// A body's id, checked at runtime: the response is a server's, not a typed fixture.
function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what}`);
  return id;
}

function activityTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event): string[] => {
    const type = field(event, "type");
    return typeof type === "string" ? [type] : [];
  });
}

let databaseForHelpers: Database;
const currentDatabase = () => databaseForHelpers;

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  const cause = rootCause(error);
  const name =
    typeof cause === "object" && cause !== null
      ? (Reflect.get(cause, "constraint") ?? Reflect.get(cause, "constraint_name"))
      : undefined;
  return [cause?.message ?? String(error), typeof name === "string" ? name : ""]
    .filter((part) => part !== "")
    .join(" ");
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

async function insertHuman(email: string, isSystemAdministrator = false) {
  const [human] = await currentDatabase()
    .db.insert(humans)
    .values({
      id: randomUUID(),
      email,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`now()`,
      isSystemAdministrator,
    })
    .returning();
  if (human === undefined) throw new Error("the account was not created");
  return human;
}

async function sessionFor(humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await currentDatabase()
    .db.insert(browserSessions)
    .values({
      id: randomUUID(),
      humanId,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
  return `orrery_session=${token}`;
}

async function addMembership(workspaceId: string, humanId: string) {
  await currentDatabase()
    .db.insert(workspaceMemberships)
    .values({ id: randomUUID(), workspaceId, humanId, isOwner: false });
}

// A second verified account with a live session and (optionally) a workspace
// membership. Direct fixtures keep the point on project behavior, not invitation mail.
async function secondHuman(email: string, workspaceId?: string) {
  const human = await insertHuman(email);
  if (workspaceId !== undefined) await addMembership(workspaceId, human.id);
  return { human, cookie: await sessionFor(human.id) };
}

async function adminId() {
  const [admin] = await currentDatabase()
    .db.select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL));
  if (admin === undefined) throw new Error("the administrator was not found");
  return admin.id;
}

async function personalWorkspaceId(humanId: string) {
  const [workspace] = await currentDatabase()
    .db.select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("the personal workspace was not found");
  return workspace.id;
}

async function createSharedWorkspace(app: Hono, cookie: string, name: string) {
  const res = await postJson(app, "/api/workspaces", { name }, cookie);
  expect(res.status).toBe(201);
  return Workspace.parse(await res.json());
}

async function createProject(app: Hono, cookie: string, workspaceId: string, name: string) {
  const res = await postJson(app, `/api/workspaces/${workspaceId}/projects`, { name }, cookie);
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createIssue(app: Hono, cookie: string, projectId: string, title = "An issue") {
  const res = await postJson(app, `/api/projects/${projectId}/issues`, { title }, cookie);
  expect(res.status).toBe(201);
  return { id: idOf(await res.json(), "the issue id") };
}

async function grantAccess(
  app: Hono,
  cookie: string,
  projectId: string,
  email: string,
  level: "read" | "contribute" | "manage",
) {
  const res = await patchJson(app, `/api/projects/${projectId}/access`, { email, level }, cookie);
  expect(res.status).toBe(200);
  return ProjectAccessGrant.parse(await res.json());
}

describe("shared project access", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    databaseForHelpers = database;
    const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  afterEach(async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`delete from project_access_events`);
      await tx.execute(sql`delete from project_access_grants`);
      await tx.execute(sql`delete from project_activity`);
      await tx.execute(sql`delete from issue_comments`);
      await tx.execute(sql`delete from knowledge_entries`);
      await tx.execute(sql`delete from issues`);
      await tx.execute(sql`delete from projects`);
      await tx.execute(sql`delete from workspace_events`);
      await tx.execute(sql`delete from workspace_invitations`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from invitations`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from instance_settings`);
      await tx.execute(sql`delete from email_verification_tokens`);
      await tx.execute(sql`delete from humans`);
    });
  });

  function makeApp() {
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const projects = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
    });
    const workspacesFeature = createWorkspacesFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: async () => {},
      log: silentLogger,
      revokeMemberProjectAccess: (tx, targetWorkspaceId, humanId, actorHumanId) =>
        projects.revokeMemberProjectAccess(tx, targetWorkspaceId, humanId, actorHumanId),
    });
    return createApp({
      features: [accounts, workspacesFeature, projects],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
  }

  async function readyApp() {
    const app = makeApp();
    await bootstrapAdmin(app);
    const id = await adminId();
    return {
      app,
      admin: { id, email: ADMIN_EMAIL },
      adminCookie: await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD),
      personalWorkspaceId: await personalWorkspaceId(id),
    };
  }

  it("lets a shared workspace owner create and manage every project", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");

    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    expect(project).toMatchObject({
      workspaceId: workspace.id,
      name: "Launch",
      workspaceKind: "shared",
      accessLevel: "manage",
      createdBy: { email: ADMIN_EMAIL },
    });

    const listed = await getJson(app, `/api/workspaces/${workspace.id}/projects`, adminCookie);
    expect(listed.status).toBe(200);
    expect(ProjectsResponse.parse(await listed.json())).toEqual([project]);

    const renamed = await patchJson(
      app,
      `/api/projects/${project.id}`,
      { name: "Launch Plan" },
      adminCookie,
    );
    expect(renamed.status).toBe(200);
    expect(Project.parse(await renamed.json())).toMatchObject({
      id: project.id,
      name: "Launch Plan",
      workspaceKind: "shared",
      accessLevel: "manage",
    });

    const activity = await getJson(app, `/api/projects/${project.id}/activity`, adminCookie);
    expect(activity.status).toBe(200);
    expect(activityTypes(await activity.json())).toEqual(["project_created", "project_renamed"]);
  });

  it("grants Create projects and gives the member Manage on the project they create", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");
    const ownerProject = await createProject(app, adminCookie, workspace.id, "Owner Project");
    const member = await secondHuman(MEMBER_EMAIL, workspace.id);

    // Membership alone grants no project access, and no creation permission.
    const memberWorkspace = await getJson(app, `/api/workspaces/${workspace.id}`, member.cookie);
    expect(memberWorkspace.status).toBe(200);
    expect(Workspace.parse(await memberWorkspace.json())).toMatchObject({
      id: workspace.id,
      isOwner: false,
      canCreateProjects: false,
    });
    const memberList = await getJson(
      app,
      `/api/workspaces/${workspace.id}/projects`,
      member.cookie,
    );
    expect(memberList.status).toBe(200);
    expect(await memberList.json()).toEqual([]);
    await expectProblem(
      await getJson(app, `/api/projects/${ownerProject.id}`, member.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "No" },
        member.cookie,
      ),
      403,
      "project_creation_not_allowed",
    );

    // The owner grants the capability; the member sees it and can create.
    const members = await getJson(app, `/api/workspaces/${workspace.id}/members`, adminCookie);
    expect(members.status).toBe(200);
    expect(WorkspaceMembersResponse.parse(await members.json())).toContainEqual(
      expect.objectContaining({ humanId: member.human.id, canCreateProjects: false }),
    );

    const granted = await patchJson(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      { canCreateProjects: true },
      adminCookie,
    );
    expect(granted.status).toBe(200);
    expect(WorkspaceMember.parse(await granted.json())).toMatchObject({
      humanId: member.human.id,
      canCreateProjects: true,
    });

    const [grantEvent] = await database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.type, "create_projects_granted"));
    expect(grantEvent).toMatchObject({
      workspaceId: workspace.id,
      actorHumanId: await adminId(),
      subjectHumanId: member.human.id,
    });

    const memberProject = await createProject(app, member.cookie, workspace.id, "Member Project");
    expect(memberProject).toMatchObject({
      workspaceId: workspace.id,
      workspaceKind: "shared",
      accessLevel: "manage",
      createdBy: { humanId: member.human.id, email: MEMBER_EMAIL },
    });

    // The creator's Manage is persisted as an explicit grant, and the member sees only
    // the project they may access.
    const [creatorGrant] = await database.db
      .select()
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, memberProject.id));
    expect(creatorGrant).toMatchObject({
      humanId: member.human.id,
      level: "manage",
      grantedByHumanId: member.human.id,
    });
    const visible = await getJson(app, `/api/workspaces/${workspace.id}/projects`, member.cookie);
    expect(visible.status).toBe(200);
    expect(ProjectsResponse.parse(await visible.json())).toEqual([memberProject]);

    // The owner still manages every project in the workspace, including the member's.
    const ownerView = await getJson(app, `/api/projects/${memberProject.id}`, adminCookie);
    expect(ownerView.status).toBe(200);
    expect(Project.parse(await ownerView.json())).toMatchObject({
      id: memberProject.id,
      accessLevel: "manage",
    });
    const ownerRename = await patchJson(
      app,
      `/api/projects/${memberProject.id}`,
      { name: "Member Project Renamed" },
      adminCookie,
    );
    expect(ownerRename.status).toBe(200);
    const ownerList = await getJson(app, `/api/workspaces/${workspace.id}/projects`, adminCookie);
    expect(ownerList.status).toBe(200);
    expect(ProjectsResponse.parse(await ownerList.json()).map((item) => item.id)).toEqual([
      ownerProject.id,
      memberProject.id,
    ]);

    // Revocation takes the creation capability away and is recorded too.
    const revoked = await patchJson(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      { canCreateProjects: false },
      adminCookie,
    );
    expect(revoked.status).toBe(200);
    expect(WorkspaceMember.parse(await revoked.json()).canCreateProjects).toBe(false);
    await expectProblem(
      await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "No" },
        member.cookie,
      ),
      403,
      "project_creation_not_allowed",
    );
    const revokeEvents = await database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.type, "create_projects_revoked"));
    expect(revokeEvents).toHaveLength(1);
  });

  it("enforces Read, Contribute, and Manage through direct requests", async () => {
    const { app, adminCookie, personalWorkspaceId: adminPersonal } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");
    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    const issue = await createIssue(app, adminCookie, project.id);
    const knowledgeRes = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Runbook" },
      adminCookie,
    );
    expect(knowledgeRes.status).toBe(201);
    const knowledge = { id: idOf(await knowledgeRes.json(), "the knowledge entry id") };

    const member = await secondHuman(MEMBER_EMAIL, workspace.id);
    const colleague = await secondHuman(COLLEAGUE_EMAIL, workspace.id);
    const outsider = await secondHuman(OUTSIDER_EMAIL);
    await addMembership(workspace.id, outsider.human.id);
    // The outsider is a member only to prove grants to non-members are refused; a
    // non-member fixture below proves cross-workspace denial.
    const nonMember = await secondHuman("nonmember@example.com");

    // Read: every read path works; every mutation and every management path refuses.
    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "read");
    const reads = [
      `/api/projects/${project.id}`,
      `/api/projects/${project.id}/issues`,
      `/api/issues/${issue.id}`,
      `/api/issues/${issue.id}/comments`,
      `/api/projects/${project.id}/activity`,
      `/api/projects/${project.id}/knowledge`,
      `/api/knowledge/${knowledge.id}`,
    ];
    for (const path of reads) {
      const res = await getJson(app, path, member.cookie);
      expect(res.status).toBe(200);
    }

    const deniedMutations = [
      await postJson(app, `/api/projects/${project.id}/issues`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/issues/${issue.id}`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/issues/${issue.id}`, { status: "closed" }, member.cookie),
      await postJson(app, `/api/issues/${issue.id}/comments`, { body: "No" }, member.cookie),
      await postJson(app, `/api/projects/${project.id}/knowledge`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/knowledge/${knowledge.id}`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/projects/${project.id}`, { name: "No" }, member.cookie),
      await getJson(app, `/api/projects/${project.id}/access`, member.cookie),
      await patchJson(
        app,
        `/api/projects/${project.id}/access`,
        { email: COLLEAGUE_EMAIL, level: "read" },
        member.cookie,
      ),
      await deleteRequest(
        app,
        `/api/projects/${project.id}/access/${colleague.human.id}`,
        member.cookie,
      ),
    ];
    for (const res of deniedMutations) {
      await expectProblem(res, 403, "insufficient_project_access");
    }

    // An ordinary member sees none of another workspace's project, even by direct id.
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}`, nonMember.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/projects/${adminPersonal}`, nonMember.cookie),
      404,
      "project_not_found",
    );

    // Contribute: edit, close, reopen, comment, and knowledge work; management still not.
    const contribute = await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "contribute");
    expect(contribute).toMatchObject({ level: "contribute", email: MEMBER_EMAIL });

    const createdIssue = await postJson(
      app,
      `/api/projects/${project.id}/issues`,
      { title: "Contributed issue" },
      member.cookie,
    );
    expect(createdIssue.status).toBe(201);
    const contributedIssue = { id: idOf(await createdIssue.json(), "the contributed issue id") };

    const edited = await patchJson(
      app,
      `/api/issues/${contributedIssue.id}`,
      { title: "Edited by member" },
      member.cookie,
    );
    expect(edited.status).toBe(200);
    const closed = await patchJson(
      app,
      `/api/issues/${contributedIssue.id}`,
      { status: "closed" },
      member.cookie,
    );
    expect(closed.status).toBe(200);
    const reopened = await patchJson(
      app,
      `/api/issues/${contributedIssue.id}`,
      { status: "open" },
      member.cookie,
    );
    expect(reopened.status).toBe(200);
    const commented = await postJson(
      app,
      `/api/issues/${contributedIssue.id}/comments`,
      { body: "A member comment." },
      member.cookie,
    );
    expect(commented.status).toBe(201);
    const createdKnowledge = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Member knowledge" },
      member.cookie,
    );
    expect(createdKnowledge.status).toBe(201);
    const editedKnowledge = await patchJson(
      app,
      `/api/knowledge/${knowledge.id}`,
      { body: "Updated by member." },
      member.cookie,
    );
    expect(editedKnowledge.status).toBe(200);

    await expectProblem(
      await patchJson(app, `/api/projects/${project.id}`, { name: "No" }, member.cookie),
      403,
      "insufficient_project_access",
    );
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}/access`, member.cookie),
      403,
      "insufficient_project_access",
    );

    // Manage: settings and access grants, including granting another manager and
    // revoking them again. Every change is attributed in the database.
    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "manage");
    const renamed = await patchJson(
      app,
      `/api/projects/${project.id}`,
      { name: "Launch Plan" },
      member.cookie,
    );
    expect(renamed.status).toBe(200);
    expect(Project.parse(await renamed.json())).toMatchObject({ name: "Launch Plan" });

    const accessList = await getJson(app, `/api/projects/${project.id}/access`, member.cookie);
    expect(accessList.status).toBe(200);
    expect(ProjectAccessGrantsResponse.parse(await accessList.json())).toContainEqual(
      expect.objectContaining({ humanId: member.human.id, level: "manage" }),
    );

    const colleagueGrant = await grantAccess(
      app,
      member.cookie,
      project.id,
      COLLEAGUE_EMAIL,
      "read",
    );
    expect(colleagueGrant).toMatchObject({
      email: COLLEAGUE_EMAIL,
      level: "read",
      grantedBy: { email: MEMBER_EMAIL },
    });
    const colleagueRead = await getJson(app, `/api/projects/${project.id}`, colleague.cookie);
    expect(colleagueRead.status).toBe(200);
    expect(Project.parse(await colleagueRead.json()).accessLevel).toBe("read");

    const deleted = await deleteRequest(
      app,
      `/api/projects/${project.id}/access/${colleague.human.id}`,
      member.cookie,
    );
    expect(deleted.status).toBe(204);
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}`, colleague.cookie),
      404,
      "project_not_found",
    );

    // A grant to a non-member is refused, and nothing is written.
    await expectProblem(
      await patchJson(
        app,
        `/api/projects/${project.id}/access`,
        { email: "stranger@example.com", level: "read" },
        member.cookie,
      ),
      404,
      "member_not_found",
    );

    // The access events record every real change, with both sides and levels.
    const events = await database.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.projectId, project.id))
      .orderBy(projectAccessEvents.createdAt, projectAccessEvents.id);
    expect(
      events.map((event) => ({
        type: event.type,
        level: event.level,
        previousLevel: event.previousLevel,
        subject: event.subjectHumanId,
        actor: event.actorHumanId,
      })),
    ).toEqual([
      {
        type: "project_access_granted",
        level: "read",
        previousLevel: null,
        subject: member.human.id,
        actor: await adminId(),
      },
      {
        type: "project_access_level_changed",
        level: "contribute",
        previousLevel: "read",
        subject: member.human.id,
        actor: await adminId(),
      },
      {
        type: "project_access_level_changed",
        level: "manage",
        previousLevel: "contribute",
        subject: member.human.id,
        actor: await adminId(),
      },
      {
        type: "project_access_granted",
        level: "read",
        previousLevel: null,
        subject: colleague.human.id,
        actor: member.human.id,
      },
      {
        type: "project_access_revoked",
        level: null,
        previousLevel: "read",
        subject: colleague.human.id,
        actor: member.human.id,
      },
    ]);

    // Removing the managing member ends their project access and records the cleanup,
    // so a later rejoin cannot revive the old grant.
    const removed = await deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      adminCookie,
    );
    expect(removed.status).toBe(204);
    const memberGrants = await database.db
      .select()
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.humanId, member.human.id));
    expect(memberGrants).toEqual([]);
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}`, member.cookie),
      404,
      "project_not_found",
    );
    const removalEvents = await database.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.subjectHumanId, member.human.id));
    expect(removalEvents.map((event) => event.type)).toContain("project_access_revoked");
  });

  it("keeps personal projects private and gives the system administrator no free access", async () => {
    const { app, admin, adminCookie, personalWorkspaceId: adminPersonal } = await readyApp();
    const adminProject = await createProject(app, adminCookie, adminPersonal, "Private Notes");
    const adminIssue = await createIssue(app, adminCookie, adminProject.id, "Private issue");

    const member = await secondHuman(MEMBER_EMAIL);
    const outsider = await secondHuman(OUTSIDER_EMAIL);

    // A second human cannot list or fetch the personal workspace's projects, and cannot
    // read an issue or knowledge entry inside one.
    await expectProblem(
      await getJson(app, `/api/workspaces/${adminPersonal}/projects`, member.cookie),
      404,
      "workspace_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/projects/${adminProject.id}`, member.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/issues/${adminIssue.id}`, member.cookie),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/workspaces/${adminPersonal}/projects`, outsider.cookie),
      404,
      "workspace_not_found",
    );

    // Another team's shared workspace and project are invisible by direct id.
    const otherWorkspace = await createSharedWorkspace(app, outsider.cookie, "Elsewhere");
    const otherProject = await createProject(app, outsider.cookie, otherWorkspace.id, "Their Work");
    await expectProblem(
      await getJson(app, `/api/projects/${otherProject.id}`, member.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/workspaces/${otherWorkspace.id}/projects`, member.cookie),
      404,
      "workspace_not_found",
    );

    // The installation administrator is not a member of Elsewhere: no access from the
    // role alone.
    await expectProblem(
      await getJson(app, `/api/projects/${otherProject.id}`, adminCookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/workspaces/${otherWorkspace.id}/projects`, adminCookie),
      404,
      "workspace_not_found",
    );

    // Membership alone still grants nothing, even for the system administrator.
    await addMembership(otherWorkspace.id, admin.id);
    const list = await getJson(app, `/api/workspaces/${otherWorkspace.id}/projects`, adminCookie);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    await expectProblem(
      await getJson(app, `/api/projects/${otherProject.id}`, adminCookie),
      404,
      "project_not_found",
    );

    // And the outsider cannot reach the administrator's personal project either.
    await expectProblem(
      await getJson(app, `/api/projects/${adminProject.id}`, outsider.cookie),
      404,
      "project_not_found",
    );
  });

  it("enforces grant scope and level shapes at the database", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");
    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    const member = await secondHuman(MEMBER_EMAIL, workspace.id);
    const outsider = await secondHuman(OUTSIDER_EMAIL);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");

    const personal = await createProject(
      app,
      adminCookie,
      await personalWorkspaceId(admin.id),
      "Private",
    );

    expect(
      await rejection(
        database.db.insert(projectAccessGrants).values({
          id: randomUUID(),
          projectId: personal.id,
          humanId: member.human.id,
          level: "read",
          grantedByHumanId: admin.id,
        }),
      ),
    ).toContain("project_access_grant_shared_only");

    expect(
      await rejection(
        database.db.insert(projectAccessGrants).values({
          id: randomUUID(),
          projectId: project.id,
          humanId: outsider.human.id,
          level: "read",
          grantedByHumanId: admin.id,
        }),
      ),
    ).toContain("project_access_grant_member");

    // Deliberately outside the contract enum, which Drizzle's typed insert cannot
    // express: raw SQL is the only way to test the database's own CHECK.
    expect(
      await rejection(
        database.sql`
          insert into project_access_grants
            (id, project_id, human_id, level, granted_by_human_id)
          values
            (${randomUUID()}, ${project.id}, ${member.human.id}, ${"owner"}, ${admin.id})
        `,
      ),
    ).toContain("project_access_grants_level");

    // A wrong event shape is refused: a grant cannot carry a previous level.
    expect(
      await rejection(
        database.db.insert(projectAccessEvents).values({
          id: randomUUID(),
          projectId: project.id,
          actorHumanId: admin.id,
          subjectHumanId: member.human.id,
          type: "project_access_granted",
          level: "read",
          previousLevel: "contribute",
        }),
      ),
    ).toContain("project_access_events_shape");

    // The valid counterparts still insert.
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: project.id,
      humanId: member.human.id,
      level: "read",
      grantedByHumanId: admin.id,
    });
    await database.db.insert(projectAccessEvents).values({
      id: randomUUID(),
      projectId: project.id,
      actorHumanId: admin.id,
      subjectHumanId: member.human.id,
      type: "project_access_granted",
      level: "read",
    });
  });
});
