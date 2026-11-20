import { randomUUID } from "node:crypto";
import {
  ProjectAccessLevel,
  ProjectActivityType,
  WorkSessionStatus,
  type ActiveWorkSession,
  type AgentIdentity,
  type AssigneeType,
  type Issue,
  type ReadyWorkFilter,
  type ReacquireWorkSessionInput,
  type ResumeDisposition,
  type ResumeWorkSessionInput,
  type ResumeWorkSessionResult,
  type LogSessionActivityInput,
  type SessionActivity,
  type WorkSession,
  type WorkSessionOutcome,
} from "@orrery/contract";
import { and, desc, eq, gt, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias, type PgInsertValue } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  agents,
  humans,
  issueDependencies,
  issues,
  projectActivity,
  projects,
  runs,
  workSessionActivities,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { WorkActor } from "../projects/index.ts";
import { decideReacquire, resumeDispositionFor, workSessionMachine } from "./state-machine.ts";

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
  | "issue_needs_input"
  | "issue_blocked"
  | "session_required"
  | "human_sign_in_required"
  | "agents_cannot_request_stop"
  | "session_not_active"
  | "session_not_found"
  | "issue_assigned_to_human"
  | "issue_assigned_to_other_agent";

const messages: Record<SessionsErrorKind, string> = {
  not_signed_in: "An agent key is required.",
  issue_not_found: "No such issue is in scope for this agent.",
  project_not_found: "No such project is in scope for the caller.",
  run_not_found: "No such run belongs to this agent in this workspace.",
  insufficient_access: "Contribute access is required to work on this issue.",
  issue_claimed: "Another worker holds the active session for this issue.",
  issue_needs_input: "This issue needs human input and cannot be claimed yet.",
  issue_blocked: "This issue is closed or paused for input and cannot be reacquired yet.",
  session_required: "This agent holds no live session for this issue.",
  human_sign_in_required: "Sign in as a human to request a stop.",
  agents_cannot_request_stop: "Only a human with Contribute or Manage access may request a stop.",
  session_not_active: "The work session is no longer active.",
  session_not_found: "No such work session is in scope for the caller.",
  issue_assigned_to_human: "This issue is assigned to a human and cannot be claimed by an agent.",
  issue_assigned_to_other_agent: "This issue is assigned to another agent and cannot be claimed.",
};

export class SessionsError extends Error {
  readonly kind: SessionsErrorKind;

  constructor(kind: SessionsErrorKind) {
    super(messages[kind]);
    this.name = "SessionsError";
    this.kind = kind;
  }
}

// The other side of a blocked_by edge in ready work: a distinct SQL name so the same
// issues table can be the candidate row and the row that blocks it in one query.
const blockerIssue = alias(issues, "blocker_issue");

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
  // The deadline of an open question on this issue, evaluated on the caller's locked tx.
  // A check-in may never renew a claim past it. A due question is paused (releasing the
  // claim) by evaluateQuestionDeadline before any renewal decision is made.
  // Optional for standalone service construction (tests); createFeatures wires both.
  questionLeaseDeadline?:
    | ((tx: DbTransaction, issueId: string) => Promise<Date | null>)
    | undefined;
  evaluateQuestionDeadline?: ((tx: DbTransaction, issueId: string) => Promise<void>) | undefined;
}

// The adapter always resolves an agent key before claiming, renewing or stopping: a work
// session has no human-session path. Reads accept either actor through WorkActor.
export type AgentActor = { kind: "agent"; identity: AgentIdentity };

export interface SessionsService {
  claim(actor: AgentActor | null, input: { issueId: string; runId: string }): Promise<WorkSession>;
  // The optional sessionId is a fence: a delayed call from a session that has since
  // expired is refused even if the same agent now holds a newer live session on the issue.
  renew(actor: AgentActor | null, issueId: string, sessionId?: string): Promise<WorkSession>;
  progress(
    actor: AgentActor | null,
    issueId: string,
    summary: string,
    sessionId?: string,
  ): Promise<WorkSession>;
  stop(
    actor: AgentActor | null,
    issueId: string,
    outcome: WorkSessionOutcome,
    sessionId?: string,
  ): Promise<WorkSession>;
  // #82: a human-only stop request on an active session. It records the actor, time and
  // optional reason and surfaces stopRequested on the agent's next check-in; it never
  // ends the session or changes its status.
  requestStop(actor: WorkActor | null, issueId: string, reason?: string): Promise<WorkSession>;
  // Live sessions in a workspace the caller can read, for the agents view. A read in
  // database time: it never renews a lease and never materializes expiry.
  activeSessions(actor: WorkActor | null, workspaceId: string): Promise<ActiveWorkSession[]>;
  // #40: a pure, database-time read of the original run's claim, and the only way to
  // re-arm an expired claim. Resume never mutates; reacquire creates a fresh active
  // session (carrying the recorded progress) only when the issue is actually available.
  resume(actor: AgentActor | null, input: ResumeWorkSessionInput): Promise<ResumeWorkSessionResult>;
  reacquire(actor: AgentActor | null, input: ReacquireWorkSessionInput): Promise<WorkSession>;
  getSession(actor: WorkActor | null, issueId: string): Promise<WorkSession>;
  listSessions(actor: WorkActor | null, issueId: string): Promise<WorkSession[]>;
  // #83: append-only, ephemeral session telemetry. Append needs the live session the
  // calling agent holds (with the same optional sessionId fence as the other writes);
  // reading a session's timeline needs only Read access on the issue's project. Activities
  // live in their own table, so expiry and completion never erase them.
  logActivity(actor: AgentActor | null, input: LogSessionActivityInput): Promise<SessionActivity>;
  listActivities(
    actor: WorkActor | null,
    issueId: string,
    sessionId: string,
  ): Promise<SessionActivity[]>;
  // #84: the optional filter narrows the ready queue; the result is always ordered
  // assigned-to-caller first, then priority, position and creation (#88).
  readyWork(actor: WorkActor | null, projectId: string, filter?: ReadyWorkFilter): Promise<Issue[]>;
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
  stopRequestedAt: workSessions.stopRequestedAt,
  stopRequestedByHumanId: workSessions.stopRequestedByHumanId,
  stopReason: workSessions.stopReason,
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
    // A stop request is a signal, not a status: the session stays active until the agent
    // acknowledges it or the lease expires, so readers can tell "stopping" from "stopped".
    stopRequested: row.stopRequestedAt !== null,
    stopRequestedAt: iso(row.stopRequestedAt),
    stopReason: row.stopReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: iso(row.endedAt),
  };
}

// A projection of one activity row. The run id is read from the session at append time;
// callers cannot attribute telemetry to a run the holding session never belonged to.
const activityColumns = {
  id: workSessionActivities.id,
  workSessionId: workSessionActivities.workSessionId,
  runId: workSessionActivities.runId,
  kind: workSessionActivities.kind,
  summary: workSessionActivities.summary,
  detail: workSessionActivities.detail,
  createdAt: workSessionActivities.createdAt,
};

type ActivityRow = typeof workSessionActivities.$inferSelect;

function toActivity(row: ActivityRow): SessionActivity {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    runId: row.runId,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function requireAgent(actor: AgentActor | null) {
  if (actor === null) throw new SessionsError("not_signed_in");
  return actor.identity;
}

// #84: the strict claim policy. Assignment is only a pull-queue hint, but an agent may
// claim (or reacquire) an issue only while it is unassigned or assigned to that same
// agent. A human assignee or a sibling agent keeps the claim reserved even when nobody
// holds a lease. Called on the issue's locked row, so a concurrent reassignment cannot
// slip between this decision and the session insert.
function assertClaimAssignee(
  assigneeType: AssigneeType | null,
  assigneeId: string | null,
  agentId: string,
): void {
  if (assigneeType === "human") throw new SessionsError("issue_assigned_to_human");
  if (assigneeType === "agent" && assigneeId !== agentId) {
    throw new SessionsError("issue_assigned_to_other_agent");
  }
}

// The ready queue's stable first sort key: work reserved for the caller goes ahead of
// everything else. Humans have no claim, but seeing their own assigned work first is the
// same board hint; agents get the strict claimable queue.
function assignedToActor(issue: Issue, actor: WorkActor): boolean {
  if (issue.assignee === null) return false;
  return actor.kind === "agent"
    ? issue.assignee.agentId === actor.identity.agentId
    : issue.assignee.humanId === actor.account.humanId;
}

// A claim is only as live as its agent's human's access to the workspace. Key
// authentication already refuses a removed member's key, but a request that authenticated
// just before removal still carries a valid identity. Re-reading access inside the claim's
// own transaction closes that window: a removal that committed first (or concurrently) is
// visible here, so a renewal can never extend a claim the removed human no longer owns.
// Personal workspaces have no membership row, so their single owner stays in scope.
async function humanStillHasWorkspaceAccess(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (workspace === undefined) return false;
  if (workspace.personalOwnerHumanId === humanId) return true;
  const [membership] = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

// Take the agent's human's membership lock BEFORE any issue lock. Removal deletes the
// membership before it locks issues to release claims, so one shared lock order
// (workspace_memberships -> issues) makes the two write paths serialize in either order
// instead of writing skewed: if the DELETE wins, this key-share read sees no row; if this
// lock wins, the DELETE waits until the claim/renewal commits and removal's release pass
// then sees the newly committed claim. Personal workspaces have no membership row; their
// single owner is checked directly and cannot be removed.
async function lockAgentWorkspaceAccess(tx: DbTransaction, identity: AgentIdentity): Promise<void> {
  // Lock the agent owner's account before any workspace or issue lock, for personal and
  // shared workspaces alike. Deactivation writes humans.deactivated_at in its own
  // transaction; waiting on this key-share lock makes a claim/renewal/reacquire that read
  // an active account either commit before the deactivation (and be visible to its claim
  // release pass) or see the deactivated account and fail here. No active session can be
  // inserted after the account was suspended.
  const [owner] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, identity.humanId), isNull(humans.deactivatedAt)))
    .for("key share");
  if (owner === undefined) throw new SessionsError("insufficient_access");

  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, identity.workspaceId))
    .limit(1);
  if (workspace === undefined) throw new SessionsError("insufficient_access");
  if (workspace.personalOwnerHumanId === identity.humanId) return;
  const [membership] = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, identity.workspaceId),
        eq(workspaceMemberships.humanId, identity.humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .for("key share");
  if (membership === undefined) throw new SessionsError("insufficient_access");
}

// Workspace removal/leave ends every active claim held by the departing human's agents in
// that workspace, in the *removing* transaction. It never touches their personal work,
// their other memberships, or the issue comments and agent attribution already recorded.
// Active issues are locked FOR UPDATE in id order before the sessions are ended: claims,
// renewals and fenced writes all lock the same issue first, so this ordering serializes
// with a renewal racing removal without deadlocking. No nested transaction is opened —
// the caller already holds the ownership lock and one DbTransaction.
export async function releaseMemberWorkSessions(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<void> {
  const ownedAgents = tx.select({ id: agents.id }).from(agents).where(eq(agents.humanId, humanId));
  const claims = await tx
    .select({ id: workSessions.id, issueId: workSessions.issueId })
    .from(workSessions)
    .where(
      and(
        eq(workSessions.workspaceId, workspaceId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        inArray(workSessions.agentId, ownedAgents),
      ),
    );
  if (claims.length === 0) return;

  const issueIds = [...new Set(claims.map((claim) => claim.issueId))].toSorted();
  await tx
    .select({ id: issues.id })
    .from(issues)
    .where(inArray(issues.id, issueIds))
    .orderBy(issues.id)
    .for("update");

  const claimIds = claims.map((claim) => claim.id);
  // Materialize already-lapsed claims as 'expired' first so a departure never overwrites
  // an already-expired session into 'released' (preserving terminal expiry semantics).
  workSessionMachine.assertTransition("active", WorkSessionStatus.enum.expired);
  await tx
    .update(workSessions)
    .set({
      status: WorkSessionStatus.enum.expired,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.status, WorkSessionStatus.enum.active),
        lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        inArray(workSessions.id, claimIds),
      ),
    );

  workSessionMachine.assertTransition("active", WorkSessionStatus.enum.released);
  await tx
    .update(workSessions)
    .set({
      // "released" ends the live claim without marking it failed or completed: the human
      // left, the work itself is untouched and stays open for another worker to claim.
      status: WorkSessionStatus.enum.released,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        // A claim that legitimately completed or expired after the read above must not be
        // overwritten to "released"; only the still-live ones are ended by a departure.
        eq(workSessions.status, WorkSessionStatus.enum.active),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        inArray(workSessions.id, claimIds),
      ),
    );
}

// Lock the target issue first. Every claim, renewal, fenced write, progress update and
// completion runs inside this lock, so the lazy expiry and the subsequent decision see one
// consistent state and two writers to the same issue serialize.
async function lockIssue(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      needsInput: issues.needsInput,
      assigneeType: issues.assigneeType,
      assigneeId: issues.assigneeId,
    })
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

// The database-time liveness predicate is repeated on every read and write that treats a
// session as live. `statement_timestamp()` advances between statements in a transaction, so
// a lease can lapse after expireStale ran; without this predicate a later statement could
// still return or update that row as active.
const liveLease = gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`);

async function findActive(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select(sessionColumns)
    .from(workSessions)
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        liveLease,
      ),
    )
    .limit(1);
  return row;
}

// Shared by claim, resume and reacquire: a run belongs to this agent in this workspace.
async function requireRun(tx: DbTransaction, identity: AgentIdentity, runId: string) {
  const [run] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.agentId, identity.agentId),
        eq(runs.workspaceId, identity.workspaceId),
      ),
    )
    .limit(1);
  if (run === undefined) throw new SessionsError("run_not_found");
  return run;
}

// The most recent session this run recorded on the issue: the one resume reports and the
// one reacquire may extend. The id tie-breaker keeps "most recent" deterministic when two
// rows share a timestamp.
async function findLatestForRun(
  tx: DbTransaction,
  issueId: string,
  identity: AgentIdentity,
  runId: string,
) {
  const [row] = await tx
    .select(sessionColumns)
    .from(workSessions)
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.agentId, identity.agentId),
        eq(workSessions.workspaceId, identity.workspaceId),
        eq(workSessions.runId, runId),
      ),
    )
    .orderBy(desc(workSessions.createdAt), desc(workSessions.id))
    .limit(1);
  return row;
}

function isSameRun(
  session: SessionView | undefined,
  identity: AgentIdentity,
  runId: string,
): boolean {
  return (
    session !== undefined &&
    session.agentId === identity.agentId &&
    session.workspaceId === identity.workspaceId &&
    session.runId === runId
  );
}

// Insert a fresh active row under the issue lock. If a lease lapsed in the tiny window
// between expireStale and this INSERT, the partial unique index refuses the first attempt;
// expiring again in this same transaction frees the slot and the retry wins. A second
// failure means a genuinely different live claimant holds the issue.
async function insertFreshSession(
  tx: DbTransaction,
  issueId: string,
  values: PgInsertValue<typeof workSessions>,
): Promise<SessionView | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [created] = await tx
      .insert(workSessions)
      .values(values)
      .onConflictDoNothing()
      .returning(sessionColumns);
    if (created !== undefined) return created;
    await expireStale(tx, issueId);
  }
  return undefined;
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
    // Re-read the human's workspace access on the caller's transaction. A removed human's
    // in-flight renewal cannot pass here even if the project grant read below is stale,
    // so the claim cannot be retained or extended after removal.
    if (!(await humanStillHasWorkspaceAccess(tx, project.workspaceId, humanId))) {
      throw new SessionsError("insufficient_access");
    }
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

// #82 human stop gate. Non-members and deactivated humans answer 404 like a missing
// issue, so a stop probe cannot enumerate issues; members below Contribute answer 403.
// Locks follow M22's order — human (KEY SHARE) -> membership (KEY SHARE) -> issue
// (UPDATE) — so a deactivation that committed first is visible here and one in flight
// waits for this decision instead of racing past it.
async function requireHumanStopAccess(
  tx: DbTransaction,
  deps: Pick<SessionsDeps, "projectAccessCeiling" | "projectAccessAtLeast">,
  humanId: string,
  issueId: string,
) {
  // Read the project first, without a lock, only to learn which workspace to lock. The
  // authoritative existence and access checks happen under the locks below.
  const [issueRef] = await tx
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issueRef === undefined) throw new SessionsError("issue_not_found");
  const [projectRef] = await tx
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, issueRef.projectId))
    .limit(1);
  if (projectRef === undefined) throw new SessionsError("issue_not_found");

  const [caller] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .for("key share");
  if (caller === undefined) throw new SessionsError("issue_not_found");

  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, projectRef.workspaceId))
    .limit(1);
  if (workspace === undefined) throw new SessionsError("issue_not_found");
  if (workspace.personalOwnerHumanId !== humanId) {
    // A suspended membership grants no access; a missing one is indistinguishable from
    // a missing issue to the caller (404).
    const [membership] = await tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, projectRef.workspaceId),
          eq(workspaceMemberships.humanId, humanId),
          isNull(workspaceMemberships.suspendedAt),
        ),
      )
      .for("key share");
    if (membership === undefined) throw new SessionsError("issue_not_found");
  }

  // Now the authoritative row lock and the project level on the same snapshot.
  const issue = await lockIssue(tx, issueId);
  const ceiling = await deps.projectAccessCeiling(tx, projectRef.workspaceId, humanId, [
    issue.projectId,
  ]);
  const level = ceiling.get(issue.projectId) ?? null;
  if (level === null || !deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.contribute)) {
    throw new SessionsError("insufficient_access");
  }
  return issue;
}

// #83 read boundary. Unlike a claim write, an activity read is allowed by project Read on
// either actor kind. Every failure — missing issue, foreign workspace, absent membership,
// a key without this project in scope, or a level below Read — answers 404 so an unrelated
// caller cannot enumerate issues or sessions. The check is a read on the caller's own
// transaction and never expires or renews a lease.
async function requireActivityReadAccess(
  tx: DbTransaction,
  deps: Pick<SessionsDeps, "projectAccessCeiling" | "projectAccessAtLeast">,
  actor: WorkActor,
  issueId: string,
): Promise<void> {
  const [issue] = await tx
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issue === undefined) throw new SessionsError("issue_not_found");
  const [project] = await tx
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  if (project === undefined) throw new SessionsError("issue_not_found");
  if (actor.kind === "agent" && actor.identity.workspaceId !== project.workspaceId) {
    throw new SessionsError("issue_not_found");
  }
  const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;
  // #22/M22: a deactivated caller — human or an agent's human owner — gets the same 404
  // as an unrelated one. Re-read this inside the caller's transaction so a deactivation
  // that committed first cannot leave an activity read alive through a stale identity.
  const [caller] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .limit(1);
  if (caller === undefined) throw new SessionsError("issue_not_found");
  if (!(await humanStillHasWorkspaceAccess(tx, project.workspaceId, humanId))) {
    throw new SessionsError("issue_not_found");
  }
  const ceiling = await deps.projectAccessCeiling(tx, project.workspaceId, humanId, [
    issue.projectId,
  ]);
  const humanLevel = ceiling.get(issue.projectId) ?? null;
  let level: ProjectAccessLevel | null = humanLevel;
  if (actor.kind === "agent") {
    const keyLevel = actor.identity.projects.find(
      (grant) => grant.projectId === issue.projectId,
    )?.level;
    if (keyLevel === undefined) throw new SessionsError("issue_not_found");
    level =
      humanLevel === null
        ? null
        : deps.projectAccessAtLeast(humanLevel, keyLevel)
          ? keyLevel
          : humanLevel;
  }
  if (level === null || !deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read)) {
    throw new SessionsError("issue_not_found");
  }
}

export function createSessionsService({
  db,
  projectAccessCeiling,
  projectAccessAtLeast,
  listIssues,
  questionLeaseDeadline,
  evaluateQuestionDeadline,
}: SessionsDeps): SessionsService {
  // Standalone construction (unit tests) has no inbox wired; production provides both.
  const leaseDeadline = questionLeaseDeadline ?? (async () => null);
  const checkDeadline = evaluateQuestionDeadline ?? (async () => {});
  // The in-transaction expiry below decides the claim. A lapsed lease must also be
  // released when the operation is refused — the rejected transaction rolls back — so a
  // committed expiry runs first, *before* any transaction is opened by this feature. It is
  // idempotent: the second, locked expiry inside the operation serializes with the claim.
  const expireCommitted = (issueId: string) => db.transaction((tx) => expireStale(tx, issueId));
  // A due one-hour question must commit its pause even when the check-in or claim that
  // triggered it is refused, otherwise the deadline would be re-evaluated forever. Like
  // lease expiry, it runs in its own committed transaction before the operation's tx.
  // Skip the row lock entirely when no open question exists on the issue (the common case).
  const deadlineCommitted = async (issueId: string) => {
    if (evaluateQuestionDeadline === undefined) return;
    const deadline = await db.transaction((tx) => leaseDeadline(tx, issueId), {
      accessMode: "read only",
    });
    if (deadline === null) return;
    await db.transaction(async (tx) => {
      // Lock in the same order as every other writer (issues -> questions -> work_sessions).
      // Without this, a due question could lock questions first and deadlock (40P01) against
      // an answer or check-in already holding the issue row.
      const [row] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
        .for("update");
      if (row === undefined) return;
      await checkDeadline(tx, issueId);
    });
  };

  // Renew, progress, stop and activity logging share one live-session decision: lock the
  // issue, expire a stale lease, re-check the agent's current project level, find the live
  // session the agent holds, then apply the one write. Only that write differs. The session
  // row is passed through so an activity can take its run id from the session itself.
  const withLiveSession = async <T>(
    actor: AgentActor | null,
    issueId: string,
    sessionId: string | undefined,
    write: (tx: DbTransaction, session: SessionView, issueId: string) => Promise<T | undefined>,
  ): Promise<T> => {
    const identity = requireAgent(actor);
    await deadlineCommitted(issueId);
    await expireCommitted(issueId);
    return db.transaction(async (tx) => {
      // Membership first, issue second: see lockAgentWorkspaceAccess for the lock order.
      await lockAgentWorkspaceAccess(tx, identity);
      const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
      const issue = await lockIssue(tx, issueId);
      await expireStale(tx, issue.id);
      // A due question pauses the issue and releases the claim before any check-in. The
      // evaluation runs on this locked transaction, never in a nested one.
      await checkDeadline(tx, issue.id);
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
            liveLease,
            // A named fence must resolve to this exact session. A delayed call from S1
            // cannot fall through to the newer S2 the same agent now holds.
            ...(sessionId === undefined ? [] : [eq(workSessions.id, sessionId)]),
          ),
        )
        .limit(1);
      // An inactive session is never revived and a stale write never becomes a new claim.
      if (session === undefined) throw new SessionsError("session_required");
      const result = await write(tx, session, issue.id);
      if (result === undefined) throw new SessionsError("session_required");
      return result;
    });
  };

  return {
    async claim(actor, input) {
      const identity = requireAgent(actor);
      await deadlineCommitted(input.issueId);
      await expireCommitted(input.issueId);
      return db.transaction(async (tx) => {
        // Membership first, issue second: a removal deleting this membership waits for
        // the claim to commit, then releases it instead of missing the uncommitted row.
        await lockAgentWorkspaceAccess(tx, identity);
        const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
        const issue = await lockIssue(tx, input.issueId);
        await expireStale(tx, issue.id);
        await checkDeadline(tx, issue.id);
        // The locked evaluation may have just set Needs input; re-read it on this same
        // snapshot so a deadline that lands between the committed check and this lock
        // cannot let a new claim start while the issue is paused.
        const [fresh] = await tx
          .select({ needsInput: issues.needsInput })
          .from(issues)
          .where(eq(issues.id, issue.id))
          .limit(1);
        await requireAccess(
          { kind: "agent", identity },
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          "issue_not_found",
        );
        // A session follows the agent and run, not the key. An explicit run id must be a
        // run of this agent in this workspace; helpers on one issue pass the same id.
        await requireRun(tx, identity, input.runId);
        // #84: a reserved issue is not claimable, even by its previous run reconnecting.
        assertClaimAssignee(issue.assigneeType, issue.assigneeId, identity.agentId);

        const existing = await findActive(tx, issue.id);
        if (existing !== undefined) {
          if (isSameRun(existing, identity, input.runId)) return toSession(existing);
          throw new SessionsError("issue_claimed");
        }
        // A paused or open question owns Needs input: nobody may start new work on the
        // issue until a human answers and clears the flag.
        if (fresh?.needsInput ?? false) throw new SessionsError("issue_needs_input");

        const created = await insertFreshSession(tx, issue.id, {
          id: randomUUID(),
          agentId: identity.agentId,
          runId: input.runId,
          workspaceId: identity.workspaceId,
          issueId: issue.id,
          status: WorkSessionStatus.enum.active,
          leaseExpiresAt: fiveMinutes,
          createdAt: sql`statement_timestamp()`,
          updatedAt: sql`statement_timestamp()`,
        });
        if (created !== undefined) return toSession(created);

        // A different live claimant won the partial unique index; it is never joined.
        throw new SessionsError("issue_claimed");
      });
    },

    async renew(actor, issueId, sessionId) {
      return withLiveSession(actor, issueId, sessionId, async (tx, session, issue) => {
        // While a question is open, checking in keeps the claim but never past the one-hour
        // deadline. After the deadline the question has been paused by the evaluation above,
        // so there is no live session left to renew.
        const deadline = await leaseDeadline(tx, issue);
        const lease =
          deadline === null
            ? fiveMinutes
            : sql`least(statement_timestamp() + interval '5 minutes', ${deadline.toISOString()}::timestamptz)`;
        const [updated] = await tx
          .update(workSessions)
          .set({ leaseExpiresAt: lease, updatedAt: sql`statement_timestamp()` })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        return updated === undefined ? undefined : toSession(updated);
      });
    },

    async progress(actor, issueId, summary, sessionId) {
      return withLiveSession(actor, issueId, sessionId, async (tx, session) => {
        const [updated] = await tx
          .update(workSessions)
          .set({
            progress: summary,
            progressUpdatedAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        return updated === undefined ? undefined : toSession(updated);
      });
    },

    async stop(actor, issueId, outcome, sessionId) {
      const nextStatus = workSessionMachine.assertTransition("active", outcome);
      return withLiveSession(actor, issueId, sessionId, async (tx, session) => {
        const [updated] = await tx
          .update(workSessions)
          .set({
            status: nextStatus,
            endedAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        return updated === undefined ? undefined : toSession(updated);
      });
    },

    async logActivity(actor, input) {
      // withLiveSession already locked the issue, expired a lapsed lease in database time
      // and found this agent's one live session (or refused the fence). The INSERT happens
      // on that same transaction, so the activity can never be written against a session
      // that was not live at the moment of the append. No UPDATE to work_sessions follows:
      // expiry and completion leave every already-written activity untouched.
      return withLiveSession(actor, input.issueId, input.sessionId, async (tx, session) => {
        const [row] = await tx
          .insert(workSessionActivities)
          .values({
            id: randomUUID(),
            workSessionId: session.id,
            runId: session.runId,
            kind: input.kind,
            summary: input.summary,
            detail: input.detail ?? null,
            createdAt: sql`statement_timestamp()`,
          })
          .returning(activityColumns);
        return row === undefined ? undefined : toActivity(row);
      });
    },

    async requestStop(actor, issueId, reason) {
      // A stop request is human-only: a bearer key must never ask its operator to stop,
      // and a missing cookie is a different mistake from presenting an agent key.
      if (actor === null) throw new SessionsError("human_sign_in_required");
      if (actor.kind === "agent") throw new SessionsError("agents_cannot_request_stop");
      const humanId = actor.account.humanId;
      const normalized = reason?.trim() === "" ? undefined : reason?.trim();

      // Nothing is mutated before authorization. Lazy expiry happens after the human,
      // membership and issue checks on the same locked transaction. An inactive session
      // returns a sentinel so its committed expiry survives the refusal; the error is
      // raised only after that transaction commits.
      const outcome = await db.transaction(async (tx) => {
        const issue = await requireHumanStopAccess(
          tx,
          { projectAccessCeiling, projectAccessAtLeast },
          humanId,
          issueId,
        );
        await expireStale(tx, issue.id);

        const [session] = await tx
          .select(sessionColumns)
          .from(workSessions)
          .where(
            and(
              eq(workSessions.issueId, issue.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .limit(1);
        if (session === undefined) return { error: "session_not_active" as const };

        // Idempotent: a repeated request never overwrites the recorded actor, time or
        // reason, and never writes a second activity row.
        if (session.stopRequestedAt !== null) return { session: toSession(session) };

        // The UPDATE rechecks liveness in database time: a lease lapsing between the read
        // and this write cannot receive a stop request.
        const [updated] = await tx
          .update(workSessions)
          .set({
            stopRequestedAt: sql`statement_timestamp()`,
            stopRequestedByHumanId: humanId,
            stopReason: normalized ?? null,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        if (updated === undefined) return { error: "session_not_active" as const };

        // The stop request is part of the project's permanent history, written in the same
        // transaction as the signal so activity can never disagree with the session. The
        // summary is an optional reason snapshot, never a credential or internal id.
        await tx.insert(projectActivity).values({
          id: randomUUID(),
          projectId: issue.projectId,
          type: ProjectActivityType.enum.issue_stop_requested,
          issueId: issue.id,
          actorHumanId: humanId,
          summary: normalized ?? "Stop requested",
          createdAt: sql`statement_timestamp()`,
        });

        return { session: toSession(updated) };
      });
      if ("error" in outcome) throw new SessionsError(outcome.error);
      return outcome.session;
    },

    async activeSessions(actor, workspaceId) {
      const caller = requireActor(actor);
      // A read in database time: it never renews a lease or materializes expiry. Projects
      // the caller cannot read are omitted, so the listing is not an enumeration oracle.
      return db.transaction(
        async (tx) => {
          let projectIds: string[];
          if (caller.kind === "agent") {
            if (caller.identity.workspaceId !== workspaceId) return [];
            const ceiling = await projectAccessCeiling(
              tx,
              workspaceId,
              caller.identity.humanId,
              caller.identity.projects.map((grant) => grant.projectId),
            );
            projectIds = caller.identity.projects
              .filter((grant) => projectAccessAtLeast(grant.level, ProjectAccessLevel.enum.read))
              .filter((grant) => {
                const current = ceiling.get(grant.projectId);
                return (
                  current !== null &&
                  current !== undefined &&
                  projectAccessAtLeast(current, ProjectAccessLevel.enum.read)
                );
              })
              .map((grant) => grant.projectId);
          } else {
            if (!(await humanStillHasWorkspaceAccess(tx, workspaceId, caller.account.humanId))) {
              return [];
            }
            const rows = await tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.workspaceId, workspaceId));
            if (rows.length === 0) return [];
            const ceiling = await projectAccessCeiling(
              tx,
              workspaceId,
              caller.account.humanId,
              rows.map((row) => row.id),
            );
            projectIds = rows
              .filter((row) => {
                const level = ceiling.get(row.id);
                return (
                  level !== null &&
                  level !== undefined &&
                  projectAccessAtLeast(level, ProjectAccessLevel.enum.read)
                );
              })
              .map((row) => row.id);
          }
          if (projectIds.length === 0) return [];
          const rows = await tx
            .select({ ...sessionColumns, projectId: issues.projectId })
            .from(workSessions)
            .innerJoin(issues, eq(workSessions.issueId, issues.id))
            .where(
              and(
                eq(workSessions.workspaceId, workspaceId),
                eq(workSessions.status, WorkSessionStatus.enum.active),
                liveLease,
                inArray(issues.projectId, projectIds),
              ),
            )
            .orderBy(desc(workSessions.createdAt));
          return rows.map((row) => Object.assign(toSession(row), { projectId: row.projectId }));
        },
        { accessMode: "read only" },
      );
    },

    async resume(actor, input) {
      const identity = requireAgent(actor);
      // Resume is a read. It deliberately does NOT call expireCommitted or expireStale:
      // the effectiveStatus projection below reports a lapsed lease as expired in
      // database time without ever resurrecting or re-arming it.
      return db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          const [issue] = await tx
            .select({ projectId: issues.projectId })
            .from(issues)
            .where(eq(issues.id, input.issueId))
            .limit(1);
          if (issue === undefined) throw new SessionsError("issue_not_found");
          await requireAccess(
            { kind: "agent", identity },
            issue.projectId,
            ProjectAccessLevel.enum.read,
            "issue_not_found",
          );
          await requireRun(tx, identity, input.runId);

          const row = await findLatestForRun(tx, input.issueId, identity, input.runId);
          if (row === undefined) {
            return {
              runId: input.runId,
              issueId: input.issueId,
              disposition: "none" as const satisfies ResumeDisposition,
              session: null,
            };
          }
          // The DB-time projection distinguishes a live claim from an "expired" one without
          // mutating the row: progress stays intact and the old lease stays expired.
          const effective = WorkSessionStatus.parse(row.effectiveStatus ?? row.status);
          const disposition: ResumeDisposition = resumeDispositionFor(effective);
          return {
            runId: input.runId,
            issueId: input.issueId,
            disposition,
            session: toSession(row),
          };
        },
        { accessMode: "read only" },
      );
    },

    async reacquire(actor, input) {
      const identity = requireAgent(actor);
      // As with claim, materialize a lapsed lease and a due one-hour question in committed
      // transactions first, so a refused reacquisition still releases them. Under
      // fallback_allowed the deadline may clear Needs input and keep a live claim here;
      // the locked check below is the availability decision.
      await deadlineCommitted(input.issueId);
      await expireCommitted(input.issueId);
      return db.transaction(async (tx) => {
        // Membership first, issue second: serialize with member removal just like claim.
        await lockAgentWorkspaceAccess(tx, identity);
        const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
        const issue = await lockIssue(tx, input.issueId);
        await expireStale(tx, issue.id);
        await checkDeadline(tx, issue.id);
        // Re-read the availability flags after the locked evaluation: the deadline may
        // have just paused the issue (Needs input kept) or authorized a fallback (cleared).
        const [fresh] = await tx
          .select({ status: issues.status, needsInput: issues.needsInput })
          .from(issues)
          .where(eq(issues.id, issue.id))
          .limit(1);
        await requireAccess(
          { kind: "agent", identity },
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          "issue_not_found",
        );
        await requireRun(tx, identity, input.runId);
        // #84: reacquisition obeys the same strict policy as a fresh claim.
        assertClaimAssignee(issue.assigneeType, issue.assigneeId, identity.agentId);

        // An idempotent retry after reconnect: the same run re-acquiring an issue it
        // already holds live returns that one session instead of registering a second.
        const active = await findActive(tx, issue.id);
        if (active !== undefined) {
          if (isSameRun(active, identity, input.runId)) return toSession(active);
          throw new SessionsError("issue_claimed");
        }

        // Reacquisition belongs to the run that owned the expired claim. A run that never
        // claimed, or one whose session already ended, has nothing to reacquire; it must
        // use claim instead. A stale write can never become this fresh claim.
        const prior = await findLatestForRun(tx, issue.id, identity, input.runId);
        const decision = decideReacquire(
          prior?.status,
          fresh?.status ?? issue.status,
          fresh?.needsInput ?? issue.needsInput,
        );
        if (
          prior === undefined ||
          prior.status !== WorkSessionStatus.enum.expired ||
          decision === "session_required"
        ) {
          throw new SessionsError("session_required");
        }
        // A closed or Needs-input issue is not available, even with no competing claimant.
        if (
          fresh?.status !== "open" ||
          (fresh?.needsInput ?? false) ||
          decision === "issue_blocked"
        ) {
          throw new SessionsError("issue_blocked");
        }

        // A fresh active row for the same identity, carrying forward the recorded progress
        // so an interruption does not erase work already reported.
        const created = await insertFreshSession(tx, issue.id, {
          id: randomUUID(),
          agentId: identity.agentId,
          runId: input.runId,
          workspaceId: identity.workspaceId,
          issueId: issue.id,
          status: WorkSessionStatus.enum.active,
          leaseExpiresAt: fiveMinutes,
          progress: prior.progress,
          progressUpdatedAt: prior.progressUpdatedAt,
          createdAt: sql`statement_timestamp()`,
          updatedAt: sql`statement_timestamp()`,
        });
        if (created !== undefined) return toSession(created);

        // A different live claimant won the partial unique index; it is never joined.
        throw new SessionsError("issue_claimed");
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

    async listActivities(actorArg, issueId, sessionId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          // 404 for unrelated callers, not a 403 that would confirm the issue exists.
          await requireActivityReadAccess(
            tx,
            { projectAccessCeiling, projectAccessAtLeast },
            actor,
            issueId,
          );
          const [session] = await tx
            .select({ id: workSessions.id })
            .from(workSessions)
            .where(and(eq(workSessions.id, sessionId), eq(workSessions.issueId, issueId)))
            .limit(1);
          if (session === undefined) throw new SessionsError("session_not_found");
          // A pure read: no lease expiry, no status change, no revival of a completed or
          // expired session. Once written, an activity stays readable for the whole trail.
          const rows = await tx
            .select(activityColumns)
            .from(workSessionActivities)
            .where(eq(workSessionActivities.workSessionId, session.id))
            .orderBy(desc(workSessionActivities.createdAt), desc(workSessionActivities.id));
          return rows.map(toActivity);
        },
        { accessMode: "read only" },
      );
    },

    async readyWork(actorArg, projectId, filter = "all") {
      const actor = requireActor(actorArg);
      // #84: an agent's `all` queue is exactly the claimable set — unassigned issues plus
      // its own. Issues assigned to a human or a sibling agent are never offered, because
      // the strict claim policy would refuse them anyway. Narrow filters are explicit.
      const ownType = actor.kind === "agent" ? "agent" : "human";
      const ownId = actor.kind === "agent" ? actor.identity.agentId : actor.account.humanId;
      const assigneeFilter =
        filter === "unassigned"
          ? isNull(issues.assigneeId)
          : filter === "assignedToMe"
            ? and(eq(issues.assigneeType, ownType), eq(issues.assigneeId, ownId))
            : actor.kind === "agent"
              ? or(
                  isNull(issues.assigneeId),
                  and(eq(issues.assigneeType, "agent"), eq(issues.assigneeId, ownId)),
                )
              : undefined;
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
          // #86: an issue is not ready while any of its blockers is still open. A closed
          // blocker stops matching immediately, so the issue becomes ready without any
          // dependency row being rewritten. The correlated NOT EXISTS keeps one row per
          // candidate issue even when several blockers are open.
          const noOpenBlocker = notExists(
            tx
              .select({ id: issueDependencies.id })
              .from(issueDependencies)
              .innerJoin(blockerIssue, eq(issueDependencies.blockedByIssueId, blockerIssue.id))
              .where(
                and(eq(issueDependencies.issueId, issues.id), ne(blockerIssue.status, "closed")),
              ),
          );
          // This query only produces the eligible id set. The returned order comes from
          // the projects listing below, which already orders by priority, then sortOrder,
          // then createdAt (#88). The caller's own assignments are sorted to the front of
          // that list, so REST and MCP ready work share one deterministic order (#84).
          const conditions = [
            eq(issues.projectId, projectId),
            eq(issues.status, "open"),
            eq(issues.needsInput, false),
            isNull(workSessions.id),
            noOpenBlocker,
          ];
          if (assigneeFilter !== undefined) conditions.push(assigneeFilter);
          const rows = await tx
            .select({ id: issues.id })
            .from(issues)
            .leftJoin(workSessions, live)
            .where(and(...conditions))
            .orderBy(issues.number);
          return rows.map((row) => row.id);
        },
        { accessMode: "read only" },
      );
      if (eligible.length === 0) return [];
      const ready = new Set(eligible);
      const ordered = (await listIssues(actor, projectId)).filter((issue) => ready.has(issue.id));
      // Array.prototype.sort is stable: within each assignee group the board order from
      // listIssues (priority, sortOrder, createdAt, number) is preserved exactly.
      ordered.sort((a, b) => Number(assignedToActor(b, actor)) - Number(assignedToActor(a, actor)));
      return ordered;
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
