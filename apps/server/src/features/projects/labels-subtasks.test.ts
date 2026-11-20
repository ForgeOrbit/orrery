import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Issue,
  ProjectActivityResponse,
  ProjectLabel,
  type CreateIssueRequest,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { humans, issueLabels, issues, workspaces } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature, ProjectsError, type WorkActor } from "./index.ts";

// #97 TDD seam: project-scoped labels and one-level subtasks. Every invariant is proved
// both through the service (the only deciding layer) and against the database, because a
// bypassing writer must not be able to store a second nesting level or a foreign label.

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let cookie: string;
let workspaceId: string;
let service: ReturnType<typeof createProjectsFeature>["service"];
let actor: WorkActor;

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const patch = (path: string, body: unknown) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const del = (path: string) => app.request(path, { method: "DELETE", headers: { cookie } });
const get = (path: string) => app.request(path, { headers: { cookie } });

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};

async function problemOf(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(await res.json()).toMatchObject({ status, code });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  if (error instanceof ProjectsError) return error.kind;
  throw error;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
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
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
  });
  service = projectsFeature.service;
  app = createApp({
    features: [accounts, projectsFeature],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });

  const boot = await app.request("/api/setup/admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, email: EMAIL, password: PASSWORD }),
  });
  if (boot.status !== 201) throw new Error("the administrator was not bootstrapped");
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const raw = login.headers
    .getSetCookie()
    .find((entry) => entry.startsWith("orrery_session="))
    ?.split(";")[0];
  if (raw === undefined) throw new Error("the session cookie was not set");
  cookie = raw;
  const [admin] = await database.db
    .select({
      humanId: humans.id,
      email: humans.email,
      isSystemAdministrator: humans.isSystemAdministrator,
      emailVerifiedAt: humans.emailVerifiedAt,
    })
    .from(humans)
    .where(eq(humans.email, EMAIL));
  const [personal] = await database.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, admin!.humanId));
  workspaceId = personal!.id;
  actor = { kind: "human", account: admin! };
}, 120_000);

// The service is reached through the feature's public interface with the same human actor
// the REST cookie resolves to; REST assertions below cover the transport mapping.

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from issue_labels`);
    await tx.execute(sql`delete from project_labels`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from projects`);
    // Keep the bootstrapped human, workspace and session: each test reuses one login.
  });
});

async function project(name = "Labels", key = "LBL"): Promise<string> {
  const res = await post(`/api/workspaces/${workspaceId}/projects`, { name, key });
  expect(res.status).toBe(201);
  return text(field(await res.json(), "id"), "the project id");
}

async function issue(projectId: string, input: CreateIssueRequest = { title: "An issue" }) {
  const res = await post(`/api/projects/${projectId}/issues`, input);
  expect(res.status).toBe(201);
  return Issue.parse(await res.json());
}

describe("project-scoped labels (#97)", () => {
  it("creates, lists, renames and deletes labels, with case-insensitive uniqueness per project", async () => {
    const pid = await project();
    const created = await post(`/api/projects/${pid}/labels`, { name: "Bug", color: "#ff0000" });
    expect(created.status).toBe(201);
    const label = ProjectLabel.parse(await created.json());
    expect(label).toMatchObject({ projectId: pid, name: "Bug", color: "#ff0000" });

    const duplicate = await post(`/api/projects/${pid}/labels`, { name: "bug", color: "#00ff00" });
    await problemOf(duplicate, 409, "label_exists");
    expect(await kindOf(service.createLabel(actor, pid, { name: "BUG", color: "#00ff00" }))).toBe(
      "label_exists",
    );

    const other = await project("Other", "OTH2");
    const otherLabel = await post(`/api/projects/${other}/labels`, {
      name: "bug",
      color: "#00ff00",
    });
    expect(otherLabel.status).toBe(201);

    const listed = await get(`/api/projects/${pid}/labels`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject([{ id: label.id, name: "Bug" }]);

    const renamed = await patch(`/api/labels/${label.id}`, { name: "Defect", color: "#0000ff" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Defect", color: "#0000ff" });

    const removed = await del(`/api/labels/${label.id}`);
    expect(removed.status).toBe(204);
    const afterDelete = await get(`/api/projects/${pid}/labels`);
    expect(await afterDelete.json()).toEqual([]);
    const missing = await patch(`/api/labels/${randomUUID()}`, { name: "Nope" });
    await problemOf(missing, 404, "label_not_found");

    const events = ProjectActivityResponse.parse(
      await (await get(`/api/projects/${pid}/activity`)).json(),
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "project_label_created",
        "project_label_edited",
        "project_label_deleted",
      ]),
    );
  });

  it("attaches and detaches labels on issues, and labels appear on issue payloads", async () => {
    const pid = await project();
    const issueA = await issue(pid);
    const issueB = await issue(pid, { title: "Second" });
    const other = await project("Other", "OTH2");
    const foreign = text(
      field(
        await (
          await post(`/api/projects/${other}/labels`, { name: "Foreign", color: "#abcdef" })
        ).json(),
        "id",
      ),
      "the foreign label id",
    );
    const label = text(
      field(
        await (await post(`/api/projects/${pid}/labels`, { name: "Bug", color: "#ff0000" })).json(),
        "id",
      ),
      "the label id",
    );

    const attached = await post(`/api/issues/${issueA.id}/labels/${label}`, {});
    expect(attached.status).toBe(201);
    expect(await attached.json()).toMatchObject({
      id: issueA.id,
      labels: [{ id: label, name: "Bug", color: "#ff0000" }],
    });

    // A repeated attach is idempotent: one row, one activity event.
    const again = await post(`/api/issues/${issueA.id}/labels/${label}`, {});
    expect(again.status).toBe(201);
    const rows = await database.db
      .select()
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issueA.id));
    expect(rows).toHaveLength(1);

    const fetched = await get(`/api/issues/${issueA.id}`);
    expect(field(await fetched.json(), "labels")).toMatchObject([{ id: label }]);
    const listed = await get(`/api/projects/${pid}/issues`);
    const listedBody = await listed.json();
    expect(field(Array.isArray(listedBody) ? listedBody[0] : undefined, "labels")).toMatchObject([
      { id: label },
    ]);

    await problemOf(
      await post(`/api/issues/${issueB.id}/labels/${foreign}`, {}),
      404,
      "label_not_found",
    );
    // The database trigger refuses a foreign label even for a writer that bypasses the service.
    await expect(
      rejectionMessage(
        database.db.execute(
          sql`insert into issue_labels (issue_id, label_id) values (${issueB.id}, ${foreign})`,
        ),
      ),
    ).resolves.toMatch(/same project/i);

    const detached = await del(`/api/issues/${issueA.id}/labels/${label}`);
    expect(detached.status).toBe(200);
    expect(field(await detached.json(), "labels")).toEqual([]);

    const events = ProjectActivityResponse.parse(
      await (await get(`/api/projects/${pid}/activity`)).json(),
    );
    expect(events.filter((event) => event.type === "issue_label_added")).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("issue_label_removed");
  });
});

describe("one-level subtasks (#97)", () => {
  it("sets and clears a parent on create and update, enforcing all three service invariants", async () => {
    const pid = await project();
    const other = await project("Other", "OTH2");
    const parent = await issue(pid, { title: "Parent" });
    const child = await issue(pid, { title: "Child", parentIssueId: parent.id });
    expect(child.parentIssueId).toBe(parent.id);
    expect(parent.parentIssueId).toBeNull();

    expect(await kindOf(service.updateIssue(actor, child.id, { parentIssueId: child.id }))).toBe(
      "self_parent",
    );
    await problemOf(
      await patch(`/api/issues/${child.id}`, { parentIssueId: child.id }),
      400,
      "self_parent",
    );

    const foreign = await issue(other, { title: "Foreign" });
    expect(await kindOf(service.updateIssue(actor, child.id, { parentIssueId: foreign.id }))).toBe(
      "cross_project_parent",
    );
    await problemOf(
      await patch(`/api/issues/${child.id}`, { parentIssueId: foreign.id }),
      400,
      "cross_project_parent",
    );

    expect(await kindOf(service.updateIssue(actor, parent.id, { parentIssueId: child.id }))).toBe(
      "subtask_depth_exceeded",
    );
    await problemOf(
      await patch(`/api/issues/${parent.id}`, { parentIssueId: child.id }),
      409,
      "subtask_depth_exceeded",
    );
    const grandchild = await issue(pid, { title: "Grandchild" });
    expect(
      await kindOf(service.updateIssue(actor, grandchild.id, { parentIssueId: child.id })),
    ).toBe("subtask_depth_exceeded");
    await problemOf(
      await post(`/api/projects/${pid}/issues`, { title: "Bad parent", parentIssueId: child.id }),
      409,
      "subtask_depth_exceeded",
    );
    await problemOf(
      await post(`/api/projects/${pid}/issues`, {
        title: "Missing parent",
        parentIssueId: randomUUID(),
      }),
      404,
      "issue_not_found",
    );

    const cleared = await patch(`/api/issues/${child.id}`, { parentIssueId: null });
    expect(cleared.status).toBe(200);
    expect(field(await cleared.json(), "parentIssueId")).toBeNull();

    const events = ProjectActivityResponse.parse(
      await (await get(`/api/projects/${pid}/activity`)).json(),
    );
    expect(events.map((event) => event.type)).toContain("issue_parent_changed");
  });

  it("enforces same-project and depth-1 in the database for bypassing writers", async () => {
    const pid = await project();
    const other = await project("Other", "OTH2");
    const author = (await database.db.select({ id: humans.id }).from(humans))[0]!.id;
    const ids = await database.db
      .insert(issues)
      .values([
        {
          id: randomUUID(),
          projectId: pid,
          number: 1,
          title: "Root",
          status: "todo",
          sortOrder: 65535,
          createdByHumanId: author,
          updatedByHumanId: author,
        },
        {
          id: randomUUID(),
          projectId: pid,
          number: 2,
          title: "Child",
          status: "todo",
          sortOrder: 131070,
          createdByHumanId: author,
          updatedByHumanId: author,
        },
      ])
      .returning({ id: issues.id });

    const rootId = ids[0]!.id;
    const childId = ids[1]!.id;

    // A self-parent is a CHECK, not just a service rule.
    await expect(
      rejectionMessage(
        database.db.execute(
          sql`update issues set parent_issue_id = ${rootId} where id = ${rootId}`,
        ),
      ),
    ).resolves.toMatch(/own parent|issues_no_self_parent/i);

    // Give the child a parent, then prove a second level is refused by the trigger.
    await database.db.execute(
      sql`update issues set parent_issue_id = ${rootId} where id = ${childId}`,
    );
    const grandchildId = randomUUID();
    await expect(
      rejectionMessage(
        database.db.execute(sql`
          insert into issues (id, project_id, number, title, status, sort_order,
            created_by_human_id, updated_by_human_id, parent_issue_id)
          values (${grandchildId}, ${pid}, 3, 'Grandchild', 'todo', 196605,
            ${author}, ${author}, ${childId})
        `),
      ),
    ).resolves.toMatch(/depth/i);

    // An issue that already has children cannot become a subtask.
    await expect(
      rejectionMessage(
        database.db.execute(
          sql`update issues set parent_issue_id = ${childId} where id = ${rootId}`,
        ),
      ),
    ).resolves.toMatch(/depth|children/i);

    // Cross-project parenting is refused by the same trigger.
    const foreignId = randomUUID();
    await database.db.execute(sql`
      insert into issues (id, project_id, number, title, status, sort_order,
        created_by_human_id, updated_by_human_id)
      values (${foreignId}, ${other}, 1, 'Foreign', 'todo', 65535, ${author}, ${author})
    `);
    await expect(
      rejectionMessage(
        database.db.execute(
          sql`update issues set parent_issue_id = ${foreignId} where id = ${childId}`,
        ),
      ),
    ).resolves.toMatch(/same project/i);
  });

  it("serializes concurrent parent writes so two racers cannot create depth 2", async () => {
    const pid = await project();
    const a = await issue(pid, { title: "A" });
    const b = await issue(pid, { title: "B" });
    const c = await issue(pid, { title: "C" });

    // Both writers lock the project row first, then the two issues in ascending id order.
    const results = await Promise.allSettled([
      service.updateIssue(actor, b.id, { parentIssueId: a.id }),
      service.updateIssue(actor, a.id, { parentIssueId: c.id }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const rows = await database.db
      .select({ id: issues.id, parent: issues.parentIssueId })
      .from(issues)
      .where(eq(issues.projectId, pid));
    const parents = new Map(rows.map((row) => [row.id, row.parent]));
    // A is B's parent in one outcome; in the other A's parent change was refused. Either
    // way no stored parent may itself have a parent.
    const storedParents = [parents.get(a.id), parents.get(b.id)].filter(
      (value): value is string => value !== null && value !== undefined,
    );
    expect(storedParents.every((id) => parents.get(id) === null)).toBe(true);
  });
});
