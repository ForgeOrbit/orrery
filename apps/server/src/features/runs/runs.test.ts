import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  CreateAgentKeyResponse,
  Problem,
  type RunDetail,
  type RunReportInput,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  humans,
  runModelChanges,
  runs as runRows,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createAgentsFeature } from "../agents/index.ts";
import { createProjectsFeature } from "../projects/index.ts";
import { createRunsFeature, type RunsService } from "./index.ts";

// Real Postgres (AGENTS.md): run identity, resume preservation, model history, and
// child linkage are database behavior — the unique index and the stored rows are the
// acceptance boundary. The black-black e2e suite drives the same flows over REST/MCP.

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "runs-admin@example.com";
const ADMIN_PASSWORD = "runs-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let runsService: RunsService;
let agentAuthenticator: AgentAuthenticator;
let adminCookie: string;
let adminHumanId: string;
let workspaceId: string;
let agentId: string;
let secret: string;

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

const getJson = (path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : {});

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what} id`);
  return id;
}

// A bearer request, exactly what an MCP tool or a harness hook carries. No cookie is
// present, so an agent cannot fall back to a human session.
const bearerRequest = (token: string) =>
  new Request("http://orrery.test/api/runs/hook", {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });

// Adapters authenticate; the service receives the identity, exactly as in production.
const report = async (input: RunReportInput, token = secret) =>
  runsService.report(await agentAuthenticator(bearerRequest(token)), input);

function adminAccount() {
  return {
    humanId: adminHumanId,
    email: ADMIN_EMAIL,
    isSystemAdministrator: false,
    emailVerifiedAt: new Date(),
  };
}

function listedRuns(workspace = workspaceId): Promise<RunDetail[]> {
  return runsService.listWorkspaceRuns(adminAccount(), workspace);
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
  let authenticator: AgentAuthenticator | undefined;
  const lateAuth: AgentAuthenticator = (request) => {
    if (authenticator === undefined) throw new Error("authenticator not wired");
    return authenticator(request);
  };
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: lateAuth,
  });
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, ws, human, ids) =>
      projectsFeature.projectAccessCeiling(tx, ws, human, ids),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
  });
  authenticator = agentsFeature.authenticator;
  agentAuthenticator = agentsFeature.authenticator;
  const runsFeature = createRunsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
  });
  app = createApp({
    features: [accounts, projectsFeature, agentsFeature, runsFeature],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
  runsService = runsFeature.service;
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from run_children`);
    await tx.execute(sql`delete from run_model_changes`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspace_ownership_guards`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from instance_setup`);
    await tx.execute(sql`delete from humans`);
  });
});

async function bootstrap() {
  const setup = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(setup.status).toBe(201);
  const login = await postJson("/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  adminCookie = cookie;

  const [human] = await database.db.select().from(workspaces);
  if (human?.personalOwnerHumanId === null || human?.personalOwnerHumanId === undefined) {
    throw new Error("the personal workspace was not created");
  }
  adminHumanId = human.personalOwnerHumanId;
  workspaceId = human.id;

  const created = await postJson(
    "/api/agents",
    { name: `runs-agent-${randomUUID()}` },
    adminCookie,
  );
  expect(created.status).toBe(201);
  agentId = idOf(await created.json(), "agent");
  const issued = await postJson(
    "/api/agents/keys",
    { agentId, workspaceId, validity: "90", projects: [] },
    adminCookie,
  );
  expect(issued.status).toBe(201);
  const body = CreateAgentKeyResponse.parse(await issued.json());
  secret = body.secret;
}

describe("runs service against real Postgres", () => {
  it("keeps two clients sharing one key as distinct runs and preserves a resume", async () => {
    await bootstrap();
    const a = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "session-A" },
      model: "gpt-6.2-sol",
    });
    const b = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "session-B" },
      model: "gpt-6.2-sol",
    });
    expect(a.runId).not.toBe(b.runId);
    expect(a.harness).toBe("codex");

    // The same native session id on a fresh handshake (a resume) reuses the run.
    const resume = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "session-A" },
    });
    expect(resume.runId).toBe(a.runId);
    const byId = await report({ event: "run_heartbeat", runId: a.runId });
    expect(byId.runId).toBe(a.runId);

    const listed = await listedRuns();
    expect(listed).toHaveLength(2);
    expect(
      listed
        .map((run) => run.nativeSessionId)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["session-A", "session-B"]);
    expect(listed.every((run) => run.agentId === agentId)).toBe(true);
    expect(listed.every((run) => run.agentName.startsWith("runs-agent-"))).toBe(true);
    const [stored] = await database.db.select().from(runRows);
    expect(stored?.agentId).toBe(agentId);
  });

  it("resolves concurrent check-ins with the same key to one run", async () => {
    await bootstrap();
    const key = { harness: "claude-code", nativeSessionId: "shared-session" } as const;
    const [x, y] = await Promise.all([
      report({ event: "run_heartbeat", runKey: key }),
      report({ event: "run_heartbeat", runKey: key }),
    ]);
    expect(x.runId).toBe(y.runId);
    expect(await listedRuns()).toHaveLength(1);
  });

  it("writes one clean model-change history row for two simultaneous model reports", async () => {
    await bootstrap();
    const first = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "race-model" },
      model: "gpt-6.2-sol",
    });
    const runId = first.runId ?? "";
    await Promise.all([
      report({ event: "run_heartbeat", runId, model: "gpt-7" }),
      report({ event: "run_heartbeat", runId, model: "gpt-7" }),
    ]);
    const changes = await database.db
      .select()
      .from(runModelChanges)
      .where(eq(runModelChanges.runId, runId));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromModel: "gpt-6.2-sol", toModel: "gpt-7" });
    const listed = await listedRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.model).toBe("gpt-7");
    expect(listed[0]?.modelHistory).toHaveLength(1);
  });

  it("rejects a child runId that is a self-loop or outside the agent/workspace scope", async () => {
    await bootstrap();
    const parent = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "child-scope" },
    });
    const parentId = parent.runId ?? "";
    const childRef = { agentId: "child-a", agentType: "general-purpose" };

    // A child cannot be its own parent.
    await expect(
      report({ event: "child_started", runId: parentId, child: { ...childRef, runId: parentId } }),
    ).rejects.toMatchObject({ kind: "run_not_found" });

    // A run belonging to a different agent in the same workspace is out of scope.
    const [foreignAgent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId: adminHumanId, name: `foreign-${randomUUID()}` })
      .returning();
    if (foreignAgent === undefined) throw new Error("the foreign agent was not created");
    const [foreignRun] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId: foreignAgent.id,
        workspaceId,
        harness: "codex",
        nativeSessionId: "foreign-agent-run",
      })
      .returning();
    if (foreignRun === undefined) throw new Error("the foreign run was not created");
    await expect(
      report({
        event: "child_started",
        runId: parentId,
        child: { ...childRef, runId: foreignRun.id },
      }),
    ).rejects.toMatchObject({ kind: "run_not_found" });

    // A run in another workspace, even for the same agent, is out of scope.
    const otherWorkspace = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Other team" })
        .returning();
      if (created === undefined) throw new Error("the other workspace was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: adminHumanId,
        isOwner: true,
      });
      return created;
    });
    const [otherRun] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId,
        workspaceId: otherWorkspace.id,
        harness: "codex",
        nativeSessionId: "other-workspace-run",
      })
      .returning();
    if (otherRun === undefined) throw new Error("the other run was not created");
    await expect(
      report({
        event: "child_started",
        runId: parentId,
        child: { ...childRef, runId: otherRun.id },
      }),
    ).rejects.toMatchObject({ kind: "run_not_found" });

    // A child run in the same agent/workspace scope is accepted and linked by FK.
    const [sibling] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId,
        workspaceId,
        harness: "codex",
        nativeSessionId: "sibling-run",
      })
      .returning();
    if (sibling === undefined) throw new Error("the sibling run was not created");
    const ok = await report({
      event: "child_started",
      runId: parentId,
      child: { ...childRef, runId: sibling.id },
    });
    expect(ok.runId).toBe(parentId);
    const listed = await listedRuns();
    const children = listed.find((run) => run.id === parentId)?.children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0]?.childRunId).toBe(sibling.id);
  });

  it("links child workers to the parent run and records model changes, leaving missing values unknown", async () => {
    await bootstrap();
    const key = { harness: "codex", nativeSessionId: "parent-session" } as const;
    const first = await report({
      event: "run_started",
      runKey: key,
      model: "gpt-6.2-sol",
      harnessVersion: "0.171.0",
    });
    const child = await report({
      event: "child_started",
      runId: first.runId,
      agentId: "01a1f6bd-4995-7b01-aa8b-fc78992f5713",
      agentType: "default",
    });
    expect(child.runId).toBe(first.runId);
    await report({
      event: "child_ended",
      runId: first.runId,
      agentId: "01a1f6bd-4995-7b01-aa8b-fc78992f5713",
      agentType: "default",
    });
    const changed = await report({ event: "run_heartbeat", runId: first.runId, model: "gpt-7" });
    expect(changed.model).toBe("gpt-7");
    // Repeating the model and omitting it must not add history or erase the known value.
    await report({ event: "run_heartbeat", runId: first.runId, model: "gpt-7" });
    const unknown = await report({ event: "run_heartbeat", runId: first.runId });
    expect(unknown.model).toBe("gpt-7");

    // A run with no reported model or version stays unknown, never invented.
    const bare = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "bare" },
    });
    const noIdentity = await report({ event: "run_heartbeat", model: "orphan" });
    expect(noIdentity.runId).toBeNull();

    const listed = await listedRuns();
    expect(listed).toHaveLength(2);
    const parent = listed.find((run) => run.id === first.runId);
    expect(parent?.harnessVersion).toBe("0.171.0");
    expect(parent?.model).toBe("gpt-7");
    expect(parent?.modelHistory).toHaveLength(1);
    expect(parent?.modelHistory[0]).toMatchObject({ fromModel: "gpt-6.2-sol", toModel: "gpt-7" });
    expect(parent?.children).toHaveLength(1);
    expect(parent?.children[0]).toMatchObject({
      agentId: "01a1f6bd-4995-7b01-aa8b-fc78992f5713",
      agentType: "default",
      status: "ended",
      model: null,
    });
    const bareRun = listed.find((run) => run.id === bare.runId);
    expect(bareRun?.model).toBeNull();
    expect(bareRun?.harnessVersion).toBeNull();
  });

  it("refuses a revoked key, a run outside the key's workspace, and a human outside the workspace", async () => {
    await bootstrap();
    const own = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "own-session" },
    });

    // A run id belonging to a different workspace's agent is refused.
    const outsider = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Other" })
        .returning();
      if (created === undefined) throw new Error("the other workspace was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: adminHumanId,
        isOwner: true,
      });
      return created;
    });
    const [foreignAgent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId: adminHumanId, name: `foreign-${randomUUID()}` })
      .returning();
    if (foreignAgent === undefined) throw new Error("the foreign agent was not created");
    const [foreignRun] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId: foreignAgent.id,
        workspaceId: outsider.id,
        harness: "codex",
        nativeSessionId: "foreign-session",
      })
      .returning();
    if (foreignRun === undefined) throw new Error("the foreign run was not created");
    await expect(report({ event: "run_heartbeat", runId: foreignRun.id })).rejects.toMatchObject({
      kind: "run_not_found",
    });

    // A human who is not a member of a shared workspace cannot read its runs, through
    // either the service or the REST route.
    const [foreignHuman] = await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email: `outsider-${randomUUID()}@example.com`,
        passwordHash: "scrypt$anything",
      })
      .returning();
    if (foreignHuman === undefined) throw new Error("the foreign human was not created");
    const foreignWorkspace = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Foreign team" })
        .returning();
      if (created === undefined) throw new Error("the foreign workspace was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: foreignHuman.id,
        isOwner: true,
      });
      return created;
    });
    await expect(
      runsService.listWorkspaceRuns(adminAccount(), foreignWorkspace.id),
    ).rejects.toMatchObject({
      kind: "workspace_not_found",
    });
    const restDenied = await getJson(`/api/workspaces/${foreignWorkspace.id}/runs`, adminCookie);
    expect(restDenied.status).toBe(404);

    const revoke = await app.request(`/api/agents/keys/${(await agentKeyId()).id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(revoke.status).toBe(204);
    await expect(report({ event: "run_heartbeat", runId: own.runId ?? "" })).rejects.toMatchObject({
      kind: "key_revoked",
    });
  });
});

async function agentKeyId() {
  const res = await getJson(
    "/api/agents/keys?workspaceId=" + encodeURIComponent(workspaceId),
    adminCookie,
  );
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  const keys = field(body, "keys");
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("no key was found");
  return { id: idOf(keys[0], "key") };
}

describe("run REST reporting", () => {
  it("accepts a v1 hook event with a bearer key and exposes runs to a human session", async () => {
    await bootstrap();
    const res = await postJson(
      "/api/runs/hook",
      {
        schema: "orrery.run.hook.v1",
        event: "run_started",
        runKey: { harness: "codex", nativeSessionId: "rest-session" },
        model: "gpt-6.2-sol",
        at: new Date().toISOString(),
      },
      undefined,
      secret,
    );
    expect(res.status).toBe(200);
    const accepted: unknown = await res.json();
    expect(typeof field(accepted, "runId")).toBe("string");
    expect(field(accepted, "model")).toBe("gpt-6.2-sol");

    const listed = await getJson(`/api/workspaces/${workspaceId}/runs`, adminCookie);
    expect(listed.status).toBe(200);
    const body: unknown = await listed.json();
    const runs = field(body, "runs");
    expect(Array.isArray(runs) && runs.length === 1).toBe(true);

    const unauthenticated = await postJson("/api/runs/hook", {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "no-key" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(Problem.parse(await unauthenticated.json()).code).toBe("not_signed_in");
  });
});
