import { randomUUID } from "node:crypto";
import {
  ProjectAccessLevel,
  WorkSessionStatus,
  type AgentIdentity,
  type Issue,
  type WorkSession,
  type WorkSessionOutcome,
} from "@orrery/contract";
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { issues, projects, runs, workSessions } from "../../db/schema.ts";
import type { WorkActor } from "../projects/index.ts";

// The service is the only file that decides anything for work sessions (#36). REST and MCP
// authenticate the bearer key and validate input, then call here with the resulting agent
// identity. Sessions belong to (agent, run, workspace, issue), never to one API key, so a
// replacement key during rotation renews the very same session.

export type SessionsErrorKind =
  | "not_signed_in"
  | "issue_not_found"
  | "project_not_found"
  | "run_not_found"
  | "insufficient_access"
  | "issue_claimed"
  | "session_required";

const messages: Record<SessionsErrorKind, string> = {
  not_signed_in: "An agent key is required.",
  issue_not_found: "No such issue is in scope for this agent.",
  project_not_found: "No such project is in scope for the caller.",
  run_not_found: "No such run belongs to this agent in this workspace.",
  insufficient_access: "Contribute access is required to work on this issue.",
  issue_claimed: "Another worker holds the active session for this issue.",
  session_required: "This agent holds no live session for this issue.",
};

export class SessionsError extends Error {
  readonly kind: SessionsErrorKind;

  constructor(kind: SessionsErrorKind) {
    super(messages[kind]);
    this.name = "SessionsError";
    this.kind = kind;
  }
}

// The projects feature's one project-level resolver, borrowed through the registry so an
// agent's effective level is capped by its human owner's *current* access on every claim,
// renewal and fenced write. A downgrade to Read therefore stops a renewal immediately.
export type SessionsProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export type SessionsProjectAccessAtLeast = (
  actual: ProjectAccessLevel,
  required: ProjectAccessLevel,
) => boolean;

export interface SessionsDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: SessionsProjectAccessCeiling;
  projectAccessAtLeast: SessionsProjectAccessAtLeast;
  // Projects' public listing, borrowed so ready work returns the same Issue shape every
  // other issue listing uses. Called outside this feature's transaction, never nested.
  listIssues: (actor: WorkActor, projectId: string) => Promise<Issue[]>;
}

// The adapter always resolves an agent key before claiming, renewing or stopping: a work
// session has no human-session path. Reads accept either actor through WorkActor.
export type AgentActor = { kind: "agent"; identity: AgentIdentity };

export interface SessionsService {
  claim(actor: AgentActor | null, input: { issueId: string; runId: string }): Promise<WorkSession>;
  renew(actor: AgentActor | null, issueId: string): Promise<WorkSession>;
  progress(actor: AgentActor | null, issueId: string, summary: string): Promise<WorkSession>;
  stop(
    actor: AgentActor | null,
    issueId: string,
    outcome: WorkSessionOutcome,
  ): Promise<WorkSession>;
  getSession(actor: WorkActor | null, issueId: string): Promise<WorkSession>;
  listSessions(actor: WorkActor | null, issueId: string): Promise<WorkSession[]>;
  readyWork(actor: WorkActor | null, projectId: string): Promise<Issue[]>;
  // The narrow seam projects borrows to fence agent issue edits, closure and reopen. It
  // lazily expires a stale lease inside the caller's already issue-locked transaction and
  // answers whether this agent holds a live session. It never creates one.
  agentHoldsSession(
    tx: DbTransaction,
    agentId: string,
    workspaceId: string,
    issueId: string,
  ): Promise<boolean>;
}

type SessionRow = typeof workSessions.$inferSelect;
type SessionView = SessionRow & { effectiveStatus: string };

// A stale active lease is reported as expired even on reads, without mutating it. Writes
// materialize the same transition through expireStale() under the issue's row lock.
const sessionColumns = {
  id: workSessions.id,
  agentId: workSessions.agentId,
  runId: workSessions.runId,
  workspaceId: workSessions.workspaceId,
  issueId: workSessions.issueId,
  status: workSessions.status,
  effectiveStatus: sql<string>`case when ${workSessions.status} = 'active' and ${workSessions.leaseExpiresAt} <= statement_timestamp() then 'expired' else ${workSessions.status} end`,
  leaseExpiresAt: workSessions.leaseExpiresAt,
  progress: workSessions.progress,
  progressUpdatedAt: workSessions.progressUpdatedAt,
  createdAt: workSessions.createdAt,
  updatedAt: workSessions.updatedAt,
  endedAt: workSessions.endedAt,
};

const iso = (value: Date | null) => value?.toISOString() ?? null;

function toSession(row: SessionView): WorkSession {
  return {
    id: row.id,
    agentId: row.agentId,
    runId: row.runId,
    workspaceId: row.workspaceId,
    issueId: row.issueId,
    status: WorkSessionStatus.parse(row.effectiveStatus ?? row.status),
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    progress: row.progress,
    progressUpdatedAt: iso(row.progressUpdatedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: iso(row.endedAt),
  };
}

function requireAgent(actor: AgentActor | null) {
  if (actor === null) throw new SessionsError("not_signed_in");
  return actor.identity;
}

// Lock the target issue first. Every claim, renewal, fenced write, progress update and
// completion runs inside this lock, so the lazy expiry and the subsequent decision see one
// consistent state and two writers to the same issue serialize.
async function lockIssue(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .for("update");
  if (row === undefined) throw new SessionsError("issue_not_found");
  return row;
}

// Lazy expiry in database time: only rows whose lease has actually lapsed become expired,
// and only their status changes. Progress is a separate column and is never touched here,
// so an interruption cannot erase work already recorded.
async function expireStale(tx: DbTransaction, issueId: string): Promise<void> {
  await tx
    .update(workSessions)
    .set({
      status: WorkSessionStatus.enum.expired,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    );
}

const fiveMinutes = sql`statement_timestamp() + interval '5 minutes'`;

async function findActive(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select(sessionColumns)
    .from(workSessions)
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
      ),
    )
    .limit(1);
  return row;
}

function requireAccessArgs(
  tx: DbTransaction,
  projectAccessCeiling: SessionsProjectAccessCeiling,
  projectAccessAtLeast: SessionsProjectAccessAtLeast,
) {
  return async (
    actor: WorkActor,
    projectId: string,
    required: ProjectAccessLevel,
    missing: "issue_not_found" | "project_not_found",
  ) => {
    const [project] = await tx
      .select({ id: projects.id, workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (
      project === undefined ||
      (actor.kind === "agent" && project.workspaceId !== actor.identity.workspaceId)
    ) {
      throw new SessionsError(missing);
    }

    const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;
    const ceiling = await projectAccessCeiling(tx, project.workspaceId, humanId, [projectId]);
    const humanLevel = ceiling.get(projectId) ?? null;
    let effective = humanLevel;
    if (actor.kind === "agent") {
      const keyLevel = actor.identity.projects.find(
        (grant) => grant.projectId === projectId,
      )?.level;
      if (keyLevel === undefined) throw new SessionsError(missing);
      effective =
        humanLevel === null
          ? null
          : projectAccessAtLeast(humanLevel, keyLevel)
            ? keyLevel
            : humanLevel;
    }
    if (effective === null || !projectAccessAtLeast(effective, required)) {
      throw new SessionsError("insufficient_access");
    }
    return project;
  };
}

export function createSessionsService({
  db,
  projectAccessCeiling,
  projectAccessAtLeast,
  listIssues,
}: SessionsDeps): SessionsService {
  // The in-transaction expiry below decides the claim. A lapsed lease must also be
  // released when the operation is refused — the rejected transaction rolls back — so a
  // committed expiry runs first, *before* any transaction is opened by this feature. It is
  // idempotent: the second, locked expiry inside the operation serializes with the claim.
  const expireCommitted = (issueId: string) => db.transaction((tx) => expireStale(tx, issueId));

  // Renew, progress and stop share one live-session decision: lock the issue, expire a
  // stale lease, re-check the agent's current project level, find the live session the
  // agent holds, then apply the one update. Only the update differs between them.
  const withLiveSession = async (
    actor: AgentActor | null,
    issueId: string,
    update: (tx: DbTransaction, sessionId: string) => Promise<SessionView | undefined>,
  ): Promise<WorkSession> => {
    const identity = requireAgent(actor);
    await expireCommitted(issueId);
    return db.transaction(async (tx) => {
      const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
      const issue = await lockIssue(tx, issueId);
      await expireStale(tx, issue.id);
      await requireAccess(
        { kind: "agent", identity },
        issue.projectId,
        ProjectAccessLevel.enum.contribute,
        "issue_not_found",
      );
      const [session] = await tx
        .select(sessionColumns)
        .from(workSessions)
        .where(
          and(
            eq(workSessions.issueId, issue.id),
            eq(workSessions.agentId, identity.agentId),
            eq(workSessions.workspaceId, identity.workspaceId),
            eq(workSessions.status, WorkSessionStatus.enum.active),
          ),
        )
        .limit(1);
      // An inactive session is never revived and a stale write never becomes a new claim.
      if (session === undefined) throw new SessionsError("session_required");
      const updated = await update(tx, session.id);
      if (updated === undefined) throw new SessionsError("session_required");
      return toSession(updated);
    });
  };

  return {
    async claim(actor, input) {
      const identity = requireAgent(actor);
      await expireCommitted(input.issueId);
      return db.transaction(async (tx) => {
        const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
        const issue = await lockIssue(tx, input.issueId);
        await expireStale(tx, issue.id);
        await requireAccess(
          { kind: "agent", identity },
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          "issue_not_found",
        );
        // A session follows the agent and run, not the key. An explicit run id must be a
        // run of this agent in this workspace; helpers on one issue pass the same id.
        const [run] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, input.runId),
              eq(runs.agentId, identity.agentId),
              eq(runs.workspaceId, identity.workspaceId),
            ),
          )
          .limit(1);
        if (run === undefined) throw new SessionsError("run_not_found");

        const existing = await findActive(tx, issue.id);
        if (existing !== undefined) {
          if (
            existing.agentId === identity.agentId &&
            existing.workspaceId === identity.workspaceId &&
            existing.runId === input.runId
          ) {
            return toSession(existing);
          }
          throw new SessionsError("issue_claimed");
        }

        const [created] = await tx
          .insert(workSessions)
          .values({
            id: randomUUID(),
            agentId: identity.agentId,
            runId: input.runId,
            workspaceId: identity.workspaceId,
            issueId: issue.id,
            status: WorkSessionStatus.enum.active,
            leaseExpiresAt: fiveMinutes,
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .onConflictDoNothing()
          .returning(sessionColumns);
        if (created !== undefined) return toSession(created);

        // The partial unique index won a concurrent race: a helper on the same issue may
        // join only if it is the same agent and run; everyone else is refused.
        const winner = await findActive(tx, issue.id);
        if (
          winner !== undefined &&
          winner.agentId === identity.agentId &&
          winner.workspaceId === identity.workspaceId &&
          winner.runId === input.runId
        ) {
          return toSession(winner);
        }
        throw new SessionsError("issue_claimed");
      });
    },

    async renew(actor, issueId) {
      return withLiveSession(actor, issueId, async (tx, sessionId) => {
        const [updated] = await tx
          .update(workSessions)
          .set({ leaseExpiresAt: fiveMinutes, updatedAt: sql`statement_timestamp()` })
          .where(eq(workSessions.id, sessionId))
          .returning(sessionColumns);
        return updated;
      });
    },

    async progress(actor, issueId, summary) {
      return withLiveSession(actor, issueId, async (tx, sessionId) => {
        const [updated] = await tx
          .update(workSessions)
          .set({
            progress: summary,
            progressUpdatedAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(workSessions.id, sessionId))
          .returning(sessionColumns);
        return updated;
      });
    },

    async stop(actor, issueId, outcome) {
      return withLiveSession(actor, issueId, async (tx, sessionId) => {
        const [updated] = await tx
          .update(workSessions)
          .set({
            status: outcome,
            endedAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(workSessions.id, sessionId))
          .returning(sessionColumns);
        return updated;
      });
    },

    async getSession(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          const [issue] = await tx
            .select({ projectId: issues.projectId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .limit(1);
          if (issue === undefined) throw new SessionsError("issue_not_found");
          await requireAccess(
            actor,
            issue.projectId,
            ProjectAccessLevel.enum.read,
            "issue_not_found",
          );
          const [row] = await tx
            .select(sessionColumns)
            .from(workSessions)
            .where(eq(workSessions.issueId, issueId))
            .orderBy(desc(workSessions.createdAt))
            .limit(1);
          if (row === undefined) throw new SessionsError("session_required");
          return toSession(row);
        },
        { accessMode: "read only" },
      );
    },

    async listSessions(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          const [issue] = await tx
            .select({ projectId: issues.projectId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .limit(1);
          if (issue === undefined) throw new SessionsError("issue_not_found");
          await requireAccess(
            actor,
            issue.projectId,
            ProjectAccessLevel.enum.read,
            "issue_not_found",
          );
          const rows = await tx
            .select(sessionColumns)
            .from(workSessions)
            .where(eq(workSessions.issueId, issueId))
            .orderBy(desc(workSessions.createdAt));
          return rows.map(toSession);
        },
        { accessMode: "read only" },
      );
    },

    async readyWork(actorArg, projectId) {
      const actor = requireActor(actorArg);
      // One read-only transaction decides which issues are ready, then the projects
      // feature's public listing supplies the same Issue shape as every other listing.
      // The two transactions are sequential, never nested on the connection pool.
      const eligible = await db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          await requireAccess(actor, projectId, ProjectAccessLevel.enum.read, "project_not_found");
          // A session with a lease already past database time is not a live claim; the
          // join predicate treats it exactly like a released one without mutating it.
          const live = and(
            eq(workSessions.issueId, issues.id),
            eq(workSessions.status, WorkSessionStatus.enum.active),
            gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
          );
          const rows = await tx
            .select({ id: issues.id })
            .from(issues)
            .leftJoin(workSessions, live)
            .where(
              and(
                eq(issues.projectId, projectId),
                eq(issues.status, "open"),
                eq(issues.needsInput, false),
                isNull(workSessions.id),
              ),
            )
            .orderBy(issues.number);
          return rows.map((row) => row.id);
        },
        { accessMode: "read only" },
      );
      if (eligible.length === 0) return [];
      const ready = new Set(eligible);
      return (await listIssues(actor, projectId)).filter((issue) => ready.has(issue.id));
    },

    async agentHoldsSession(tx, agentId, workspaceId, issueId) {
      // Projects calls this inside its already issue-locked transaction. Never open a
      // second transaction here: liveness is evaluated on the caller's tx in database
      // time. The caller's lazy expiry and the DB-time filters on reads keep a lapsed
      // claim from being used, and this gate never creates a claim from a stale write.
      const [row] = await tx
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(
          and(
            eq(workSessions.issueId, issueId),
            eq(workSessions.agentId, agentId),
            eq(workSessions.workspaceId, workspaceId),
            eq(workSessions.status, WorkSessionStatus.enum.active),
            gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}

function requireActor(actor: WorkActor | null): WorkActor {
  if (actor === null) throw new SessionsError("not_signed_in");
  return actor;
}
