import { randomUUID } from "node:crypto";
import {
  RunStatus,
  type AgentIdentity,
  type Run,
  type RunChild,
  type RunDetail,
  type RunModelChange,
  type RunReportInput,
  type RunReportResponse,
} from "@orrery/contract";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agents,
  runChildren,
  runModelChanges,
  runs,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { nextChildRunStatus, nextRunStatus } from "./state-machine.ts";

// The service is the only file in this feature that decides anything. rest.ts and
// mcp.ts authenticate the bearer key through agents' narrow seam, validate input with
// the shared contract, call here with the resulting identity, and map results. No run
// identity is ever derived from an MCP transport session id or a reported name.

export type RunsErrorKind = "not_signed_in" | "run_not_found" | "workspace_not_found";

const messages: Record<RunsErrorKind, string> = {
  not_signed_in: "Not signed in.",
  run_not_found: "No such run belongs to this agent in this workspace.",
  workspace_not_found: "This workspace does not exist or you cannot access it.",
};

export class RunsError extends Error {
  readonly kind: RunsErrorKind;

  constructor(kind: RunsErrorKind) {
    super(messages[kind]);
    this.name = "RunsError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new RunsError("not_signed_in");
  return account;
}

export interface RunsDeps {
  db: PostgresJsDatabase;
}

export interface RunsService {
  // Record a hook event or an MCP check-in. A run is keyed by the authenticated agent,
  // the key's workspace, and the harness's native session id; an explicit runId wins
  // when present. Concurrent clients sharing one key stay distinct; a resume reuses
  // the existing row. Absent metadata is stored as null, never guessed.
  report(identity: AgentIdentity | null, input: RunReportInput): Promise<RunReportResponse>;
  // The human workspace view: every run in one workspace with history and children.
  listWorkspaceRuns(account: SessionAccount | null, workspaceId: string): Promise<RunDetail[]>;
}

type RunRow = typeof runs.$inferSelect;
type ChildRow = typeof runChildren.$inferSelect;
type ModelChangeRow = typeof runModelChanges.$inferSelect;

const iso = (value: Date | null) => value?.toISOString() ?? null;

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    harness: row.harness,
    harnessVersion: row.harnessVersion,
    nativeSessionId: row.nativeSessionId,
    model: row.model,
    status: RunStatus.parse(row.status),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: iso(row.endedAt),
    lastHeartbeatAt: iso(row.lastHeartbeatAt),
  };
}

function toChild(row: ChildRow): RunChild {
  return {
    id: row.id,
    runId: row.runId,
    agentId: row.agentId,
    agentType: row.agentType,
    childRunId: row.childRunId,
    model: row.model,
    status: RunStatus.parse(row.status),
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
  };
}

function toModelChange(row: ModelChangeRow): RunModelChange {
  return {
    id: row.id,
    runId: row.runId,
    fromModel: row.fromModel,
    toModel: row.toModel,
    reportedAt: iso(row.reportedAt) ?? row.createdAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(
  run: RunRow,
  agentName: string,
  history: readonly RunModelChange[],
  children: readonly RunChild[],
): RunDetail {
  return {
    ...toRun(run),
    agentName,
    modelHistory: [...history],
    children: [...children],
  };
}

// The human's right to read this workspace's runs. A personal workspace belongs to its
// one owner; a shared workspace requires membership. This is the same boundary the
// workspaces feature applies to its own reads, and it is decided here, in the service.
async function humanCanReadWorkspace(
  db: PostgresJsDatabase,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipId: workspaceMemberships.id,
    })
    .from(workspaces)
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row !== undefined && (row.personalOwnerHumanId === humanId || row.membershipId !== null);
}

async function applyChildUpdate(
  tx: DbTransaction,
  childId: string,
  model: string | null,
  ended: boolean,
  at: Date,
): Promise<void> {
  await tx
    .update(runChildren)
    .set({
      ...(model !== null ? { model } : {}),
      ...(ended
        ? { status: RunStatus.enum.ended, endedAt: at }
        : { status: RunStatus.enum.active, endedAt: null }),
    })
    .where(eq(runChildren.id, childId));
}

// Repeated reports for the same named child update its row in place; children with no
// reported identity are anonymous observations and each gets its own row. A named child
// run must be in the same agent/workspace scope and cannot be the parent itself.
async function recordChild(
  tx: DbTransaction,
  identity: AgentIdentity,
  runId: string,
  input: RunReportInput,
  observedAt: string,
): Promise<void> {
  const child = input.child ?? {};
  const agentId = child.agentId ?? input.agentId ?? null;
  const agentType = child.agentType ?? input.agentType ?? null;
  const childRunId = child.runId ?? null;
  const model = child.model ?? null;
  const childStatus = nextChildRunStatus(input.event);
  const ended = childStatus === RunStatus.enum.ended;
  const at = new Date(observedAt);

  if (childRunId !== null) {
    if (childRunId === runId) throw new RunsError("run_not_found");
    const [referred] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.id, childRunId),
          eq(runs.agentId, identity.agentId),
          eq(runs.workspaceId, identity.workspaceId),
        ),
      )
      .limit(1);
    if (referred === undefined) throw new RunsError("run_not_found");
  }

  const anonymous = agentId === null && childRunId === null;
  // Match a nullable attribution field exactly: a reported id matches only that id, and
  // an absent one matches only NULL, never a `''` sentinel.
  const byAgentId =
    agentId === null ? isNull(runChildren.agentId) : eq(runChildren.agentId, agentId);
  const byAgentType =
    agentType === null ? isNull(runChildren.agentType) : eq(runChildren.agentType, agentType);
  const byChildRunId =
    childRunId === null ? isNull(runChildren.childRunId) : eq(runChildren.childRunId, childRunId);
  const match = and(eq(runChildren.runId, runId), byAgentId, byAgentType, byChildRunId);

  if (!anonymous) {
    // Lock an existing child row so a concurrent `child_ended` or model report cannot
    // be lost to a second INSERT ... ON CONFLICT DO NOTHING.
    const [existing] = await tx.select().from(runChildren).where(match).limit(1).for("update");
    if (existing !== undefined) {
      await applyChildUpdate(tx, existing.id, model, ended, at);
      return;
    }
  }

  const [created] = await tx
    .insert(runChildren)
    .values({
      id: randomUUID(),
      runId,
      agentId,
      agentType,
      childRunId,
      model,
      status: ended ? RunStatus.enum.ended : RunStatus.enum.active,
      startedAt: at,
      endedAt: ended ? at : null,
    })
    .onConflictDoNothing()
    .returning();
  if (created === undefined && !anonymous) {
    // Another reporter inserted the same named child first; apply this report to the
    // winner under its row lock instead of silently dropping the update.
    const [raced] = await tx.select().from(runChildren).where(match).limit(1).for("update");
    if (raced !== undefined) await applyChildUpdate(tx, raced.id, model, ended, at);
  }
}

export function createRunsService({ db }: RunsDeps): RunsService {
  return {
    async report(identity, input) {
      if (identity === null) throw new RunsError("not_signed_in");
      // #29's check-in contract sends `reported: { model, harnessVersion }` and may
      // omit `at` in favour of a check-in timestamp. Both shapes resolve identically.
      const observedAt = input.at ?? input.checkIn?.at ?? new Date().toISOString();
      const at = new Date(observedAt);
      const reportedModel = input.model ?? input.reported?.model ?? null;
      const harnessVersion = input.harnessVersion ?? input.reported?.harnessVersion ?? null;
      const runKey = input.runKey ?? undefined;

      // One transaction for the whole mutation: the row lock makes the model comparison
      // and the child upsert atomic, so two concurrent A→B reports write one history row.
      return db.transaction(async (tx) => {
        let row: RunRow | undefined;
        let inserted = false;
        if (input.runId !== null && input.runId !== undefined) {
          [row] = await tx
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.id, input.runId),
                eq(runs.agentId, identity.agentId),
                eq(runs.workspaceId, identity.workspaceId),
              ),
            )
            .limit(1)
            .for("update");
          if (row === undefined) throw new RunsError("run_not_found");
        } else if (runKey !== undefined) {
          // The partial unique index enforces identity in the database, so two
          // concurrent check-ins with the same key race safely: one inserts, the other
          // reads the winner. Two native session ids under one key produce two runs.
          const [created] = await tx
            .insert(runs)
            .values({
              id: randomUUID(),
              agentId: identity.agentId,
              workspaceId: identity.workspaceId,
              harness: runKey.harness,
              harnessVersion,
              nativeSessionId: runKey.nativeSessionId,
              model: reportedModel,
              createdAt: at,
              updatedAt: at,
            })
            .onConflictDoNothing()
            .returning();
          if (created !== undefined) {
            row = created;
            inserted = true;
          } else {
            [row] = await tx
              .select()
              .from(runs)
              .where(
                and(
                  eq(runs.agentId, identity.agentId),
                  eq(runs.workspaceId, identity.workspaceId),
                  eq(runs.harness, runKey.harness),
                  eq(runs.nativeSessionId, runKey.nativeSessionId),
                ),
              )
              .limit(1)
              .for("update");
          }
          if (row === undefined) throw new RunsError("run_not_found");
        } else {
          // No identity was reported: accept the observation but record nothing. Never
          // borrow a transport session id or collapse unrelated conversations.
          return {
            runId: null,
            accepted: true,
            observedAt,
            model: reportedModel,
            harness: null,
          };
        }

        // Re-read under FOR UPDATE, including for the row this transaction just
        // inserted, so every decision below sees one consistent, locked snapshot.
        const [locked] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, row.id))
          .limit(1)
          .for("update");
        if (locked === undefined) throw new RunsError("run_not_found");
        row = locked;

        const previousModel = locked.model;
        const modelChanged = reportedModel !== null && reportedModel !== previousModel;
        const updates: Partial<typeof runs.$inferInsert> = { updatedAt: at };
        if (harnessVersion !== null && harnessVersion !== undefined) {
          updates.harnessVersion = harnessVersion;
        }
        if (modelChanged) updates.model = reportedModel;
        const nextStatus = nextRunStatus(RunStatus.parse(row.status), input.event);
        if (nextStatus === RunStatus.enum.ended && input.event === "run_ended") {
          updates.status = RunStatus.enum.ended;
          updates.endedAt = at;
        } else if (nextStatus === RunStatus.enum.active && row.status === RunStatus.enum.ended) {
          // A resumed conversation reuses the run and reactivates it.
          updates.status = RunStatus.enum.active;
          updates.endedAt = null;
        }
        if (input.event === "run_heartbeat" || input.checkIn !== undefined) {
          updates.lastHeartbeatAt = at;
        }
        const [updated] = await tx
          .update(runs)
          .set(updates)
          .where(
            and(
              eq(runs.id, row.id),
              eq(runs.agentId, identity.agentId),
              eq(runs.workspaceId, identity.workspaceId),
            ),
          )
          .returning();
        row = updated ?? row;

        // Only a real change is history: a repeated report of the same model writes no
        // event, and an absent model never overwrites a known one with `unknown`.
        if (modelChanged && !inserted) {
          await tx.insert(runModelChanges).values({
            id: randomUUID(),
            runId: row.id,
            fromModel: previousModel,
            toModel: reportedModel,
            reportedAt: at,
          });
        }

        if (
          input.child !== undefined ||
          input.event === "child_started" ||
          input.event === "child_ended"
        ) {
          await recordChild(tx, identity, row.id, input, observedAt);
        }

        return {
          runId: row.id,
          accepted: true,
          observedAt,
          model: row.model,
          harness: row.harness,
        };
      });
    },

    async listWorkspaceRuns(account, workspaceId) {
      const actor = requireAccount(account);
      if (!(await humanCanReadWorkspace(db, workspaceId, actor.humanId))) {
        throw new RunsError("workspace_not_found");
      }
      const found = await db
        .select({ run: runs, agentName: agents.name })
        .from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(eq(runs.workspaceId, workspaceId))
        .orderBy(desc(runs.createdAt));
      if (found.length === 0) return [];
      const ids = found.map((entry) => entry.run.id);
      const [changes, children] = await Promise.all([
        db
          .select()
          .from(runModelChanges)
          .where(inArray(runModelChanges.runId, ids))
          .orderBy(runModelChanges.createdAt),
        db
          .select()
          .from(runChildren)
          .where(inArray(runChildren.runId, ids))
          .orderBy(runChildren.startedAt),
      ]);
      const history = new Map<string, RunModelChange[]>();
      for (const change of changes) {
        const list = history.get(change.runId) ?? [];
        list.push(toModelChange(change));
        history.set(change.runId, list);
      }
      const kids = new Map<string, RunChild[]>();
      for (const child of children) {
        const list = kids.get(child.runId) ?? [];
        list.push(toChild(child));
        kids.set(child.runId, list);
      }
      return found.map((entry) =>
        toDetail(
          entry.run,
          entry.agentName,
          history.get(entry.run.id) ?? [],
          kids.get(entry.run.id) ?? [],
        ),
      );
    },
  };
}
