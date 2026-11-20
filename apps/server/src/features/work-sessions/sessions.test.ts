import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AgentIdentity,
  CreateAgentKeyResponse,
  Problem,
  WorkSessionResponse,
  type WorkSession,
} from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  browserSessions,
  humans,
  issues,
  projectAccessGrants,
  runs as runRows,
  workSessions,
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
import { createAgentsFeature, type AgentAuthenticator } from "../agents/index.ts";
import { createProjectsFeature, ProjectsError, type WorkSessionGate } from "../projects/index.ts";
import { createSessionsFeature, SessionsError, type SessionsService } from "./index.ts";

// Real Postgres (AGENTS.md): claims, leases, expiry and the unique index are database
// behavior. These tests use database time for every boundary and race real transactions;
// the black-box zz-sessions.spec.ts drives the same public operations through MCP.

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "sessions-admin@example.com";
const ADMIN_PASSWORD = "sessions-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let projectsService: ReturnType<typeof createProjectsFeature>["service"];
let sessionsService: SessionsService;

const atLeast = (actual: string, required: string) =>
  ["read", "contribute", "manage"].indexOf(actual) >=
  ["read", "contribute", "manage"].indexOf(required);

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

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

// The stable code from either feature's error; an unexpected error cannot masquerade as a
// session denial. Bounds the assertions without narrowing `unknown` by unsafe assertion.
function errorKind(error: unknown): string {
  if (error instanceof SessionsError || error instanceof ProjectsError) return error.kind;
  return "unexpected_error";
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
      if (gate === undefined) throw new Error("work session gate is not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
  });
  let liveAuthenticator: AgentAuthenticator | undefined;
  const lateAuth: AgentAuthenticator = (request) => {
    if (liveAuthenticator === undefined) throw new Error("authenticator not wired");
    return liveAuthenticator(request);
  };
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) => atLeast(actual, required),
  });
  liveAuthenticator = agentsFeature.authenticator;
  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) => atLeast(actual, required),
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  projectsService = projectsFeature.service;
  sessionsService = sessionsFeature.service;
  app = createApp({
    features: [accounts, projectsFeature, agentsFeature, sessionsFeature],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);
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

type Fixture = {
  cookie: string;
  humanId: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  secret: string;
};

async function bootstrap(): Promise<Fixture> {
  const setup = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(setup.status).toBe(201);
  const login = await postJson("/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie");
  const [workspace] = await database.db.select().from(workspaces);
  if (workspace?.personalOwnerHumanId == null) throw new Error("no personal workspace");
  const humanId = workspace.personalOwnerHumanId;
  const created = await postJson(
    `/api/workspaces/${workspace.id}/projects`,
    { name: "Sessions project" },
    cookie,
  );
  expect(created.status).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentName = `sessions-agent-${randomUUID()}`;
  const agentRes = await postJson("/api/agents", { name: agentName }, cookie);
  expect(agentRes.status).toBe(201);
  const agentId = idOf(await agentRes.json(), "agent");
  const keyRes = await postJson(
    "/api/agents/keys",
    {
      agentId,
      workspaceId: workspace.id,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
    cookie,
  );
  expect(keyRes.status).toBe(201);
  const secret = CreateAgentKeyResponse.parse(await keyRes.json()).secret;
  return { cookie, humanId, workspaceId: workspace.id, projectId, agentId, secret };
}

async function identityFor(secret: string): Promise<AgentIdentity> {
  const res = await getJson("/api/agents/me", undefined, secret);
  expect(res.status).toBe(200);
  return AgentIdentity.parse(await res.json());
}

async function newRun(identity: AgentIdentity): Promise<string> {
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
  return run.id;
}

async function humanIssue(f: Fixture, title: string) {
  return projectsService.createIssue(
    {
      kind: "human",
      account: {
        humanId: f.humanId,
        email: ADMIN_EMAIL,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    },
    f.projectId,
    { title },
  );
}

async function setLease(issueId: string, sqlExpression: string) {
  await database.db.execute(
    sql`update work_sessions set lease_expires_at = ${sql.raw(sqlExpression)} where issue_id = ${issueId} and status = 'active'`,
  );
}

async function activeCount(issueId: string): Promise<number> {
  const rows = await database.db
    .select({ id: workSessions.id })
    .from(workSessions)
    .where(and(eq(workSessions.issueId, issueId), eq(workSessions.status, "active")));
  return rows.length;
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => Promise.reject(new Error("expected the operation to be refused")),
    (error: unknown) => error,
  );
}

describe("work sessions against real Postgres", () => {
  it("claims and stops a session tied to the agent, run, workspace and issue", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Claimed issue");
    const runId = await newRun(identity);

    const claim = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: issue.id, runId },
    );
    expect(claim).toMatchObject({
      agentId: identity.agentId,
      runId,
      workspaceId: f.workspaceId,
      issueId: issue.id,
      status: "active",
    });
    const [row] = await database.db
      .select({ lease: workSessions.leaseExpiresAt })
      .from(workSessions)
      .where(eq(workSessions.id, claim.id));
    const [inWindow] = await database.db.execute<{ ok: boolean }>(sql`
      select ${sql.raw("true")} as ok from work_sessions
      where id = ${claim.id}
        and lease_expires_at > statement_timestamp()
        and lease_expires_at <= statement_timestamp() + interval '5 minutes' + interval '1 second'
    `);
    expect(inWindow?.ok).toBe(true);
    expect(row?.lease).toBeInstanceOf(Date);

    const stopped = await sessionsService.stop({ kind: "agent", identity }, issue.id, "completed");
    expect(stopped).toMatchObject({ status: "completed" });
    expect(stopped.endedAt).not.toBeNull();
    expect(await activeCount(issue.id)).toBe(0);
    expect(await sessionsService.readyWork({ kind: "agent", identity }, f.projectId)).toEqual([
      expect.objectContaining({ id: issue.id }),
    ]);
  });

  it("lets one of two concurrent claims win and enforces the unique index", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Raced issue");
    const runA = await newRun(identity);
    const runB = await newRun(identity);

    // The same agent racing two distinct runs must produce one active session: a second
    // run is a different worker for the same issue, not a helper joining the first.
    const results = await Promise.allSettled([
      sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId: runA }),
      sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId: runB }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(SessionsError);
    expect(errorKind(rejected?.reason)).toBe("issue_claimed");
    expect(await activeCount(issue.id)).toBe(1);

    // Even bypassing the service, Postgres refuses a second active row for the issue.
    const winner = results.find(
      (result): result is PromiseFulfilledResult<WorkSession> => result.status === "fulfilled",
    )?.value;
    let insertError: unknown;
    try {
      await database.db.insert(workSessions).values({
        id: randomUUID(),
        agentId: identity.agentId,
        runId: runB,
        workspaceId: f.workspaceId,
        issueId: issue.id,
        status: "active",
        leaseExpiresAt: new Date(Date.now() + 300_000),
      });
      insertError = new Error("the unique index did not refuse a second active session");
    } catch (error) {
      insertError = error;
    }
    expect(rootCause(insertError)).toMatchObject({
      code: "23505",
      constraint_name: "one_active_work_session_per_issue",
    });
    expect((await database.db.select().from(workSessions)).map((row) => row.id)).toEqual([
      winner?.id,
    ]);
  });

  it("expires at five minutes in database time, retaining progress and sparing other claims", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const runId = await newRun(identity);
    const a = await humanIssue(f, "Lapsing issue");
    const b = await humanIssue(f, "Healthy issue");
    await sessionsService.claim({ kind: "agent", identity }, { issueId: a.id, runId });
    await sessionsService.claim({ kind: "agent", identity }, { issueId: b.id, runId });
    await sessionsService.progress({ kind: "agent", identity }, a.id, "Halfway through");

    // Just before the deadline in DB time a check-in still works.
    await setLease(b.id, "statement_timestamp() + interval '1 second'");
    await expect(sessionsService.renew({ kind: "agent", identity }, b.id)).resolves.toMatchObject({
      status: "active",
    });

    // Just after, the lease has lapsed: renewal is refused, progress survives, and the
    // other issue's claim is untouched.
    await setLease(a.id, "statement_timestamp() - interval '1 second'");
    const error = await rejection(sessionsService.renew({ kind: "agent", identity }, a.id));
    expect(error).toBeInstanceOf(SessionsError);
    expect(errorKind(error)).toBe("session_required");
    const stored = await sessionsService.getSession({ kind: "agent", identity }, a.id);
    expect(stored).toMatchObject({ status: "expired", progress: "Halfway through" });
    expect(await activeCount(a.id)).toBe(0);
    expect(await activeCount(b.id)).toBe(1);
    const ready = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(ready.map((item) => item.id)).toContain(a.id);
    expect(ready.map((item) => item.id)).not.toContain(b.id);
  });

  it("rejects a stale edit, close, progress and completion even when nobody else claimed", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Fenced issue");
    const runId = await newRun(identity);
    await sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId });
    await sessionsService.progress({ kind: "agent", identity }, issue.id, "before lapse");
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");

    const actor = { kind: "agent" as const, identity };
    const edit = await rejection(
      projectsService.updateIssue(actor, issue.id, { title: "Stale edit" }),
    );
    expect(edit).toBeInstanceOf(ProjectsError);
    expect(errorKind(edit)).toBe("session_required");
    for (const operation of [
      () => sessionsService.progress(actor, issue.id, "after lapse"),
      () => sessionsService.renew(actor, issue.id),
      () => sessionsService.stop(actor, issue.id, "completed"),
    ]) {
      const error = await rejection(operation());
      expect(error).toBeInstanceOf(SessionsError);
      expect(errorKind(error)).toBe("session_required");
    }
    const [row] = await database.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row?.title).toBe("Fenced issue");
    expect(await activeCount(issue.id)).toBe(0);
    expect((await sessionsService.getSession(actor, issue.id)).progress).toBe("before lapse");

    // An explicit reacquisition is allowed; a stale write never did it implicitly.
    await expect(sessionsService.claim(actor, { issueId: issue.id, runId })).resolves.toMatchObject(
      { status: "active" },
    );
  });

  it("lets a replacement key renew, but a Read downgrade stops renewal and fenced writes", async () => {
    const f = await bootstrap();
    const issue = await humanIssue(f, "Rotated issue");

    // A second key for the same agent with the same scope is the rotation case: it renews
    // the very same session because the session follows the agent, not the key.
    const second = await postJson(
      "/api/agents/keys",
      {
        agentId: f.agentId,
        workspaceId: f.workspaceId,
        validity: "never",
        projects: [{ projectId: f.projectId, level: "contribute" }],
      },
      f.cookie,
    );
    expect(second.status).toBe(201);
    const replacementSecret = CreateAgentKeyResponse.parse(await second.json()).secret;
    const firstIdentity = await identityFor(f.secret);
    const replacement = await identityFor(replacementSecret);
    expect(replacement.agentId).toBe(firstIdentity.agentId);
    const runId = await newRun(firstIdentity);
    const session = await sessionsService.claim(
      { kind: "agent", identity: firstIdentity },
      { issueId: issue.id, runId },
    );
    await expect(
      sessionsService.renew({ kind: "agent", identity: replacement }, issue.id),
    ).resolves.toMatchObject({ id: session.id, status: "active" });

    // A shared-workspace member's grant can be lowered. Renewal and fenced writes re-check
    // the human's current level inside their transaction, so Read stops both immediately.
    // Owner membership and workspace commit together (the deferred owner trigger).
    const [team] = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Rotation team" })
        .returning();
      if (created === undefined) throw new Error("the team was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: f.humanId,
        isOwner: true,
      });
      return [created];
    });
    if (team === undefined) throw new Error("the team was not created");
    const teamId = team.id;
    const [member] = await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email: "rotation-member@example.com",
        passwordHash: "x",
        emailVerifiedAt: new Date(),
      })
      .returning({ id: humans.id });
    if (member === undefined) throw new Error("the member was not created");
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: teamId,
      humanId: member.id,
    });
    const memberProject = await postJson(
      `/api/workspaces/${teamId}/projects`,
      { name: "Member project" },
      f.cookie,
    );
    expect(memberProject.status).toBe(201);
    const memberProjectId = idOf(await memberProject.json(), "project");
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: memberProjectId,
      humanId: member.id,
      level: "contribute",
      grantedByHumanId: f.humanId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The agent belongs to the member: a session fixture lets the member register it and
    // issue a key, so the dynamic human-access ceiling is the member's grant.
    const memberToken = randomBytes(32).toString("base64url");
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: member.id,
      tokenHash: tokenHash(memberToken),
      expiresAt: sql`now() + interval '1 hour'`,
    });
    const memberCookie = `orrery_session=${memberToken}`;
    const memberAgent = await postJson(
      "/api/agents",
      { name: `rotation-member-bot-${randomUUID()}` },
      memberCookie,
    );
    const memberAgentId = idOf(await memberAgent.json(), "agent");
    const memberKey = await postJson(
      "/api/agents/keys",
      {
        agentId: memberAgentId,
        workspaceId: teamId,
        validity: "90",
        projects: [{ projectId: memberProjectId, level: "contribute" }],
      },
      memberCookie,
    );
    expect(memberKey.status).toBe(201);
    const memberSecret = CreateAgentKeyResponse.parse(await memberKey.json()).secret;
    let memberIdentity = await identityFor(memberSecret);
    const memberIssue = await projectsService.createIssue(
      {
        kind: "human",
        account: {
          humanId: f.humanId,
          email: ADMIN_EMAIL,
          isSystemAdministrator: false,
          emailVerifiedAt: new Date(),
        },
      },
      memberProjectId,
      { title: "Downgraded issue" },
    );
    const memberRun = await newRun(memberIdentity);
    await sessionsService.claim(
      { kind: "agent", identity: memberIdentity },
      { issueId: memberIssue.id, runId: memberRun },
    );

    // Race the renewal against the downgrade; either order is safe, but no renewal may
    // succeed once the Read grant is committed.
    const downgrade = database.db
      .update(projectAccessGrants)
      .set({ level: "read" })
      .where(
        and(
          eq(projectAccessGrants.projectId, memberProjectId),
          eq(projectAccessGrants.humanId, member.id),
        ),
      );
    await Promise.allSettled([
      sessionsService.renew({ kind: "agent", identity: memberIdentity }, memberIssue.id),
      downgrade,
    ]);
    memberIdentity = await identityFor(memberSecret);
    expect(memberIdentity.projects).toMatchObject([{ projectId: memberProjectId, level: "read" }]);
    const renewError = await rejection(
      sessionsService.renew({ kind: "agent", identity: memberIdentity }, memberIssue.id),
    );
    expect(errorKind(renewError)).toBe("insufficient_access");
    const editError = await rejection(
      projectsService.updateIssue({ kind: "agent", identity: memberIdentity }, memberIssue.id, {
        title: "After downgrade",
      }),
    );
    expect(errorKind(editError)).toBe("insufficient_project_access");
  });

  it("coordinates a parent run, shared helpers and independent subagents", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const runId = await newRun(identity);
    const parentIssues = await Promise.all(
      ["Parent A", "Parent B", "Parent C"].map((title) => humanIssue(f, title)),
    );
    const sessions = await Promise.all(
      parentIssues.map((issue) =>
        sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId }),
      ),
    );
    expect(sessions.every((session) => session.runId === runId)).toBe(true);
    expect(new Set(sessions.map((session) => session.issueId)).size).toBe(3);

    // A helper on the same issue, same agent and run, joins the existing coordinated
    // session instead of registering a second one.
    const helper = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: parentIssues[0]!.id, runId },
    );
    expect(helper.id).toBe(sessions[0]!.id);
    expect(await activeCount(parentIssues[0]!.id)).toBe(1);

    // A subagent with its own identity and run claims a different issue independently.
    const other = await postJson("/api/agents", { name: `subagent-${randomUUID()}` }, f.cookie);
    const otherId = idOf(await other.json(), "agent");
    const otherKey = await postJson(
      "/api/agents/keys",
      {
        agentId: otherId,
        workspaceId: f.workspaceId,
        validity: "90",
        projects: [{ projectId: f.projectId, level: "contribute" }],
      },
      f.cookie,
    );
    const otherIdentity = await identityFor(
      CreateAgentKeyResponse.parse(await otherKey.json()).secret,
    );
    const otherRun = await newRun(otherIdentity);
    const subagentIssue = await humanIssue(f, "Subagent issue");
    const otherSession = await sessionsService.claim(
      { kind: "agent", identity: otherIdentity },
      { issueId: subagentIssue.id, runId: otherRun },
    );
    expect(otherSession.agentId).toBe(otherId);
    expect(otherSession.runId).toBe(otherRun);
    expect(
      (await sessionsService.listSessions({ kind: "agent", identity }, subagentIssue.id)).map(
        (s) => s.id,
      ),
    ).toContain(otherSession.id);
  });

  it("lists only open, unclaimed issues that are not Needs input", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const runId = await newRun(identity);
    const plain = await humanIssue(f, "Ready");
    const claimed = await humanIssue(f, "Claimed");
    const needsInput = await humanIssue(f, "Paused");
    const closed = await humanIssue(f, "Done");
    await sessionsService.claim({ kind: "agent", identity }, { issueId: claimed.id, runId });
    await database.db.update(issues).set({ needsInput: true }).where(eq(issues.id, needsInput.id));
    await projectsService.updateIssue(
      {
        kind: "human",
        account: {
          humanId: f.humanId,
          email: ADMIN_EMAIL,
          isSystemAdministrator: false,
          emailVerifiedAt: new Date(),
        },
      },
      closed.id,
      { status: "closed" },
    );

    const ready = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(ready.map((item) => item.id)).toEqual([plain.id]);
    await setLease(claimed.id, "statement_timestamp() - interval '1 second'");
    const afterExpiry = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(afterExpiry.map((item) => item.id)).toEqual([plain.id, claimed.id]);
  });

  it("exposes claim, progress, read and stop through bearer REST", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "REST session");
    const runId = await newRun(identity);

    const claim = await postJson(
      `/api/issues/${issue.id}/work-sessions`,
      { runId },
      undefined,
      f.secret,
    );
    expect(claim.status).toBe(201);
    const session = WorkSessionResponse.parse(await claim.json());
    expect(session.session.status).toBe("active");

    const progress = await postJson(
      `/api/issues/${issue.id}/work-sessions/progress`,
      { summary: "REST progress" },
      undefined,
      f.secret,
    );
    expect(progress.status).toBe(200);
    expect(WorkSessionResponse.parse(await progress.json()).session.progress).toBe("REST progress");

    const current = await getJson(`/api/issues/${issue.id}/work-sessions`, undefined, f.secret);
    expect(current.status).toBe(200);
    const ready = await getJson(`/api/projects/${f.projectId}/ready-work`, undefined, f.secret);
    expect(ready.status).toBe(200);

    const stop = await postJson(
      `/api/issues/${issue.id}/work-sessions/stop`,
      { outcome: "released" },
      undefined,
      f.secret,
    );
    expect(stop.status).toBe(200);
    expect(WorkSessionResponse.parse(await stop.json()).session.status).toBe("released");

    // A fenced REST edit without a live session is a Problem, not a silent write.
    const edit = await postJson(
      `/api/issues/${issue.id}/work-sessions/renew`,
      {},
      undefined,
      f.secret,
    );
    await expectProblem(edit, 409, "session_required");
    expect(identity.agentId).toBe(f.agentId);
  });
});
