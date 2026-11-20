import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Issue,
  IssueComment,
  IssueCommentsResponse,
  IssuesResponse,
  KnowledgeEntriesResponse,
  KnowledgeEntry,
  Problem,
  Project,
  ProjectActivityResponse,
  ProjectsResponse,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  humans,
  issueComments,
  issues,
  knowledgeEntries,
  projectActivity,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature } from "./index.ts";

// Runs against a real Postgres (see AGENTS.md): issue numbers, activity, and authorship
// are database behavior, not mock behavior. The black-box e2e suite proves the same cycle
// through a running server.

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";

const silentLogger = createLogger("error");

const postJson = async (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const patchJson = async (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const getJson = async (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const problemBody = async (res: Response) => Problem.parse(await res.json());

async function bootstrapAdmin(app: Hono) {
  const res = await postJson(app, "/api/setup/admin", {
    secret: SECRET,
    email: EMAIL,
    password: PASSWORD,
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

let databaseForHelpers: Database;
const currentDatabase = () => databaseForHelpers;

// Drizzle wraps the driver's error; the root's message (the PostgresError's) carries the
// constraint name. Resolves with that, or the stringified error.
async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
}

async function personalWorkspaceId(humanId: string) {
  const [workspace] = await currentDatabase()
    .db.select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("the personal workspace was not found");
  return workspace.id;
}

async function adminId() {
  const [admin] = await currentDatabase()
    .db.select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, EMAIL));
  if (admin === undefined) throw new Error("the administrator was not found");
  return admin.id;
}

async function createProject(
  app: Hono,
  cookie: string,
  workspaceId: string,
  name = "Personal Project",
) {
  const res = await postJson(app, `/api/workspaces/${workspaceId}/projects`, { name }, cookie);
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createIssue(
  app: Hono,
  cookie: string,
  projectId: string,
  input: { title: string; body?: string } = { title: "First issue" },
) {
  const res = await postJson(app, `/api/projects/${projectId}/issues`, input, cookie);
  expect(res.status).toBe(201);
  return Issue.parse(await res.json());
}

async function activityFor(app: Hono, cookie: string, projectId: string) {
  const res = await getJson(app, `/api/projects/${projectId}/activity`, cookie);
  expect(res.status).toBe(200);
  return ProjectActivityResponse.parse(await res.json());
}

describe("projects", () => {
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

  // Wired like features/index.ts: accounts owns the session and bootstrap; projects owns
  // the project content and activity.
  function makeApp() {
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const projectsFeature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
    });
    const app = createApp({
      features: [accounts, projectsFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    return app;
  }

  async function readyApp() {
    const app = makeApp();
    await bootstrapAdmin(app);
    const id = await adminId();
    return {
      app,
      admin: { id, email: EMAIL },
      adminCookie: await cookieFor(app, EMAIL, PASSWORD),
      workspaceId: await personalWorkspaceId(id),
    };
  }

  it("refuses every unauthenticated path to a personal project", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const issue = await createIssue(app, adminCookie, project.id);

    expect(project).toMatchObject({
      workspaceId,
      name: "Personal Project",
      createdBy: { humanId: admin.id, email: EMAIL },
    });
    expect(project.createdAt).toMatch(/Z$/);
    expect(issue).toMatchObject({
      projectId: project.id,
      number: 1,
      status: "open",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
      closedAt: null,
    });

    // Unauthenticated requests cannot list or fetch the project, its issues, comments,
    // activity, or knowledge, and cannot create anything.
    const anonymous = [
      await getJson(app, `/api/workspaces/${workspaceId}/projects`),
      await getJson(app, `/api/projects/${project.id}`),
      await getJson(app, `/api/projects/${project.id}/issues`),
      await getJson(app, `/api/issues/${issue.id}`),
      await getJson(app, `/api/issues/${issue.id}/comments`),
      await getJson(app, `/api/projects/${project.id}/activity`),
      await getJson(app, `/api/projects/${project.id}/knowledge`),
      await postJson(app, `/api/workspaces/${workspaceId}/projects`, { name: "No" }),
      await postJson(app, `/api/projects/${project.id}/issues`, { title: "No" }),
      await postJson(app, `/api/issues/${issue.id}/comments`, { body: "No" }),
      await postJson(app, `/api/projects/${project.id}/knowledge`, { title: "No" }),
      await patchJson(app, `/api/issues/${issue.id}`, { status: "closed" }),
      await patchJson(app, `/api/knowledge/${randomUUID()}`, { title: "No" }),
    ];
    for (const res of anonymous) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 401, code: "not_signed_in" });
    }

    // The administrator's own listing still returns the project.
    const visible = await getJson(app, `/api/workspaces/${workspaceId}/projects`, adminCookie);
    expect(visible.status).toBe(200);
    expect(ProjectsResponse.parse(await visible.json())).toEqual([project]);
  });

  it("runs the issue cycle and persists authorship and activity", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const created = await createIssue(app, adminCookie, project.id, {
      title: "Write the release notes",
      body: "Draft the **release notes** for the next version.",
    });

    // Authorship is stored, not inferred from the session at read time.
    const [createdRow] = await database.db.select().from(issues).where(eq(issues.id, created.id));
    expect(createdRow).toMatchObject({
      projectId: project.id,
      number: 1,
      title: "Write the release notes",
      body: "Draft the **release notes** for the next version.",
      status: "open",
      createdByHumanId: admin.id,
      updatedByHumanId: admin.id,
      closedAt: null,
    });

    // Edit: title and body change; the last editor is recorded.
    const edited = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { title: "Write the final release notes", body: "Final **release notes**." },
      adminCookie,
    );
    expect(edited.status).toBe(200);
    const editedIssue = Issue.parse(await edited.json());
    expect(editedIssue).toMatchObject({
      title: "Write the final release notes",
      body: "Final **release notes**.",
      status: "open",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
    });
    expect(editedIssue.updatedAt >= created.updatedAt).toBe(true);

    // Comment: an ordinary discussion entry, with its author.
    const commented = await postJson(
      app,
      `/api/issues/${created.id}/comments`,
      { body: "The notes are ready for review." },
      adminCookie,
    );
    expect(commented.status).toBe(201);
    const comment = IssueComment.parse(await commented.json());
    expect(comment).toMatchObject({
      issueId: created.id,
      body: "The notes are ready for review.",
      author: { humanId: admin.id, email: EMAIL },
    });
    const [commentRow] = await database.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, comment.id));
    expect(commentRow).toMatchObject({ issueId: created.id, createdByHumanId: admin.id });

    const comments = await getJson(app, `/api/issues/${created.id}/comments`, adminCookie);
    expect(comments.status).toBe(200);
    expect(IssueCommentsResponse.parse(await comments.json())).toEqual([comment]);

    // Close: closedAt is set, and an edit while closed leaves it untouched.
    const closed = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { status: "closed" },
      adminCookie,
    );
    expect(closed.status).toBe(200);
    const closedIssue = Issue.parse(await closed.json());
    expect(closedIssue.status).toBe("closed");
    expect(closedIssue.closedAt).not.toBeNull();
    const closedAt = closedIssue.closedAt;

    const editedWhileClosed = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { body: "An addendum while closed." },
      adminCookie,
    );
    expect(editedWhileClosed.status).toBe(200);
    const stillClosed = Issue.parse(await editedWhileClosed.json());
    expect(stillClosed.status).toBe("closed");
    expect(stillClosed.closedAt).toBe(closedAt);

    // Reopen: closedAt is cleared.
    const reopened = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { status: "open" },
      adminCookie,
    );
    expect(reopened.status).toBe(200);
    const reopenedIssue = Issue.parse(await reopened.json());
    expect(reopenedIssue.status).toBe("open");
    expect(reopenedIssue.closedAt).toBeNull();

    // A repeated close is a no-op: no new event, no changed timestamp.
    const closeAgain = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { status: "open" },
      adminCookie,
    );
    expect(closeAgain.status).toBe(200);
    expect(Issue.parse(await closeAgain.json()).status).toBe("open");

    // The activity feed has one event per real change, in order, each with its actor.
    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.map((event) => event.type)).toEqual([
      "project_created",
      "issue_created",
      "issue_edited",
      "issue_commented",
      "issue_closed",
      "issue_edited",
      "issue_reopened",
    ]);
    for (const event of activity) {
      expect(event.actor).toMatchObject({ humanId: admin.id, email: EMAIL });
      expect(event.projectId).toBe(project.id);
    }
    expect(activity[0]?.summary).toBe("Personal Project");
    expect(activity[1]).toMatchObject({ summary: "Write the release notes", issueId: created.id });
    expect(activity[2]).toMatchObject({ summary: "Write the final release notes" });
    expect(activity[3]).toMatchObject({ summary: "Write the final release notes" });
    expect(activity[4]).toMatchObject({ summary: "Write the final release notes" });

    // The events are persisted, not just returned.
    const eventRows = await database.db
      .select()
      .from(projectActivity)
      .where(eq(projectActivity.projectId, project.id))
      .orderBy(projectActivity.createdAt, projectActivity.id);
    expect(eventRows.map((row) => row.type)).toEqual(activity.map((event) => event.type));
    for (const row of eventRows) expect(row.actorHumanId).toBe(admin.id);

    // The issue and its history survive a fresh read.
    const fetched = await getJson(app, `/api/issues/${created.id}`, adminCookie);
    expect(fetched.status).toBe(200);
    expect(Issue.parse(await fetched.json())).toMatchObject({
      title: "Write the final release notes",
      body: "An addendum while closed.",
      status: "open",
      createdBy: { humanId: admin.id },
      updatedBy: { humanId: admin.id },
    });
    const listed = await getJson(app, `/api/projects/${project.id}/issues`, adminCookie);
    expect(listed.status).toBe(200);
    expect(IssuesResponse.parse(await listed.json())).toHaveLength(1);
  });

  it("numbers issues per project and settles concurrent creations without duplicates", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const other = await createProject(app, adminCookie, workspaceId, "Another Project");

    const results = await Promise.all(
      ["One", "Two", "Three", "Four", "Five"].map((title) =>
        postJson(app, `/api/projects/${project.id}/issues`, { title }, adminCookie),
      ),
    );
    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    const numbers = await Promise.all(
      results.map(async (res) => Issue.parse(await res.json()).number),
    );
    expect(numbers.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    // A different project starts its own numbering at 1.
    const firstInOther = await createIssue(app, adminCookie, other.id, { title: "Other first" });
    expect(firstInOther.number).toBe(1);

    const rows = await database.db
      .select({ number: issues.number })
      .from(issues)
      .where(eq(issues.projectId, project.id));
    expect(rows.map((row) => row.number).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("creates and edits a basic Markdown knowledge entry with authorship and activity", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);

    const created = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Deployment notes", body: "# Deploy\n\nRun `pnpm build` first." },
      adminCookie,
    );
    expect(created.status).toBe(201);
    const entry = KnowledgeEntry.parse(await created.json());
    expect(entry).toMatchObject({
      projectId: project.id,
      title: "Deployment notes",
      body: "# Deploy\n\nRun `pnpm build` first.",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
    });

    const edited = await patchJson(
      app,
      `/api/knowledge/${entry.id}`,
      { title: "Deployment runbook", body: "## Deploy\n\nRun `pnpm build` then `pnpm start`." },
      adminCookie,
    );
    expect(edited.status).toBe(200);
    const editedEntry = KnowledgeEntry.parse(await edited.json());
    expect(editedEntry).toMatchObject({
      title: "Deployment runbook",
      body: "## Deploy\n\nRun `pnpm build` then `pnpm start`.",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
    });
    expect(editedEntry.updatedAt >= entry.updatedAt).toBe(true);

    const [row] = await database.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, entry.id));
    expect(row).toMatchObject({
      projectId: project.id,
      title: "Deployment runbook",
      body: "## Deploy\n\nRun `pnpm build` then `pnpm start`.",
      createdByHumanId: admin.id,
      updatedByHumanId: admin.id,
    });

    const listed = await getJson(app, `/api/projects/${project.id}/knowledge`, adminCookie);
    expect(listed.status).toBe(200);
    expect(KnowledgeEntriesResponse.parse(await listed.json())).toEqual([editedEntry]);

    const fetched = await getJson(app, `/api/knowledge/${entry.id}`, adminCookie);
    expect(fetched.status).toBe(200);
    expect(KnowledgeEntry.parse(await fetched.json())).toEqual(editedEntry);

    // A no-op edit returns the entry unchanged and records nothing.
    const noop = await patchJson(
      app,
      `/api/knowledge/${entry.id}`,
      { title: "Deployment runbook" },
      adminCookie,
    );
    expect(noop.status).toBe(200);
    expect(KnowledgeEntry.parse(await noop.json())).toEqual(editedEntry);

    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.map((event) => event.type)).toEqual([
      "project_created",
      "knowledge_created",
      "knowledge_edited",
    ]);
    expect(activity[1]).toMatchObject({
      summary: "Deployment notes",
      knowledgeEntryId: entry.id,
      actor: { humanId: admin.id, email: EMAIL },
    });
    expect(activity[2]).toMatchObject({
      summary: "Deployment runbook",
      knowledgeEntryId: entry.id,
      actor: { humanId: admin.id, email: EMAIL },
    });
  });

  it("enforces the activity target by event type at the database", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const issue = await createIssue(app, adminCookie, project.id);
    const knowledgeResponse = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Target check" },
      adminCookie,
    );
    expect(knowledgeResponse.status).toBe(201);
    const knowledge = KnowledgeEntry.parse(await knowledgeResponse.json());

    const invalid = [
      { type: "project_created", issueId: issue.id, knowledgeEntryId: null },
      { type: "project_created", issueId: null, knowledgeEntryId: knowledge.id },
      { type: "issue_created", issueId: null, knowledgeEntryId: null },
      { type: "issue_commented", issueId: issue.id, knowledgeEntryId: knowledge.id },
      { type: "knowledge_created", issueId: issue.id, knowledgeEntryId: knowledge.id },
      { type: "knowledge_edited", issueId: null, knowledgeEntryId: null },
    ] as const;
    for (const values of invalid) {
      expect(
        await rejection(
          database.db.insert(projectActivity).values({
            id: randomUUID(),
            projectId: project.id,
            actorHumanId: admin.id,
            summary: "Target check",
            createdAt: sql`statement_timestamp()`,
            ...values,
          }),
        ),
      ).toContain("project_activity_target_matches_type");
    }

    // The same shape with a matching target still inserts.
    await database.db.insert(projectActivity).values({
      id: randomUUID(),
      projectId: project.id,
      actorHumanId: admin.id,
      type: "project_created",
      summary: "Valid target",
      createdAt: sql`statement_timestamp()`,
    });
  });

  it("answers invalid ids and request shapes with validation Problems", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const tooLong = "a".repeat(201);

    const invalidIds = [
      await getJson(app, `/api/workspaces/${tooLong}/projects`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}/issues`, adminCookie),
      await getJson(app, `/api/issues/${tooLong}`, adminCookie),
      await getJson(app, `/api/issues/${tooLong}/comments`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}/activity`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}/knowledge`, adminCookie),
      await getJson(app, `/api/knowledge/${tooLong}`, adminCookie),
    ];
    for (const res of invalidIds) {
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });
    }

    const blankProject = await postJson(
      app,
      `/api/workspaces/${workspaceId}/projects`,
      { name: "   " },
      adminCookie,
    );
    expect(blankProject.status).toBe(400);
    expect(await problemBody(blankProject)).toMatchObject({
      code: "validation_failed",
      errors: [{ pointer: "/name" }],
    });

    const blankIssue = await postJson(
      app,
      `/api/projects/${project.id}/issues`,
      { title: "  " },
      adminCookie,
    );
    expect(blankIssue.status).toBe(400);
    expect(await problemBody(blankIssue)).toMatchObject({
      code: "validation_failed",
      errors: [{ pointer: "/title" }],
    });

    const validIssue = await postJson(
      app,
      `/api/projects/${project.id}/issues`,
      { title: "Valid" },
      adminCookie,
    );
    expect(validIssue.status).toBe(201);
    const issue = Issue.parse(await validIssue.json());
    const emptyComment = await postJson(
      app,
      `/api/issues/${issue.id}/comments`,
      { body: "   " },
      adminCookie,
    );
    expect(emptyComment.status).toBe(400);
    expect(await problemBody(emptyComment)).toMatchObject({ code: "validation_failed" });

    const blankKnowledge = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "  " },
      adminCookie,
    );
    expect(blankKnowledge.status).toBe(400);
    expect(await problemBody(blankKnowledge)).toMatchObject({ code: "validation_failed" });

    // Nothing invalid was stored.
    expect(await database.db.select().from(projects)).toHaveLength(1);
    expect(await database.db.select().from(issues)).toHaveLength(1);
    expect(await database.db.select().from(issueComments)).toHaveLength(0);
    expect(await database.db.select().from(knowledgeEntries)).toHaveLength(0);
  });

  it("lets a shared workspace owner create and manage its projects", async () => {
    const { app, adminCookie } = await readyApp();
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
    if (admin === undefined) throw new Error("expected bootstrapped admin");

    const sharedId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id: sharedId,
        kind: "shared",
        name: "Shared Team",
      });
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: sharedId,
        humanId: admin.id,
        isOwner: true,
      });
    });

    // The owner sees every project in the workspace and creates one; the owner's
    // effective level is Manage. A non-owner member's ceiling is covered in
    // access.test.ts, which owns the #27 access matrix.
    const empty = await getJson(app, `/api/workspaces/${sharedId}/projects`, adminCookie);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const created = await postJson(
      app,
      `/api/workspaces/${sharedId}/projects`,
      { name: "Shared Project" },
      adminCookie,
    );
    expect(created.status).toBe(201);
    expect(Project.parse(await created.json())).toMatchObject({
      workspaceId: sharedId,
      name: "Shared Project",
      workspaceKind: "shared",
      accessLevel: "manage",
    });

    const listed = await getJson(app, `/api/workspaces/${sharedId}/projects`, adminCookie);
    expect(listed.status).toBe(200);
    expect(ProjectsResponse.parse(await listed.json())).toHaveLength(1);
  });

  it("serializes concurrent issue updates so edits and closes never lose updates or duplicate events", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Concurrency");
    const issue = await createIssue(app, adminCookie, project.id, {
      title: "Original title",
      body: "Original body",
    });

    // Race a close with a title edit and a second close on the same issue.
    const [close1, editTitle, close2] = await Promise.all([
      patchJson(app, `/api/issues/${issue.id}`, { status: "closed" }, adminCookie),
      patchJson(app, `/api/issues/${issue.id}`, { title: "Updated title" }, adminCookie),
      patchJson(app, `/api/issues/${issue.id}`, { status: "closed" }, adminCookie),
    ]);
    expect(close1.status).toBe(200);
    expect(editTitle.status).toBe(200);
    expect(close2.status).toBe(200);

    const finalRes = await getJson(app, `/api/issues/${issue.id}`, adminCookie);
    expect(finalRes.status).toBe(200);
    expect(await finalRes.json()).toMatchObject({
      title: "Updated title",
      status: "closed",
    });

    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.filter((entry) => entry.type === "issue_closed")).toHaveLength(1);
    expect(activity.filter((entry) => entry.type === "issue_edited")).toHaveLength(1);
  });
});
