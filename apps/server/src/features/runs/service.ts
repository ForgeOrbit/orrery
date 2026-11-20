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
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SessionAccount } from "../accounts/index.ts";
import { type AgentAuthenticator, isAgentError } from "../agents/index.ts";
import {
  runChildren,
  runModelChanges,
  runs,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";

// The service is the only file in this feature that decides anything. rest.ts and
// mcp.ts only read credentials, validate input with the shared contract, call here, and
// map results. Agent identity comes from agents' authenticator — never from an MCP
// transport session id, a URL path, or a client-reported display name.

export type RunsErrorKind =
  | "not_signed_in"
  | "invalid_key"
  | "key_revoked"
  | "key_expired"
  | "key_workspace_inaccessible"
  | "key_out_of_scope"
  | "insufficient_agent_access"
  | "run_not_found"
  | "workspace_not_found";

const messages: Record<RunsErrorKind, string> = {
  not_signed_in: "Not signed in.",
  invalid_key: "The API key is not valid.",
  key_revoked: "The API key has been revoked.",
  key_expired: "The API key has expired.",
  key_workspace_inaccessible: "The human who owns this key can no longer use its workspace.",
  key_out_of_scope: "The API key is not scoped to this workspace.",
  insufficient_agent_access: "The agent has no access to this resource.",
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

const agentErrorKinds = new Set<string>([
  "invalid_key",
  "key_revoked",
  "key_expired",
  "key_workspace_inaccessible",
  "key_out_of_scope",
  "insufficient_agent_access",
]);

function isRunsErrorKind(value: string): value is RunsErrorKind {
  return agentErrorKinds.has(value);
}

// The agents feature owns key resolution; this feature borrows only its narrow seam and
// translates its failures into this feature's stable problem codes, so REST and MCP
// answer identically (including revoked keys and cross-workspace keys).
async function authenticateAgent(
  authenticate: AgentAuthenticator,
  request: Request,
): Promise<AgentIdentity> {
  let identity: AgentIdentity | null;
  try {
    identity = await authenticate(request);
  } catch (error) {
    if (isAgentError(error) && isRunsErrorKind(error.kind)) throw new RunsError(error.kind);
    throw error;
  }
  if (identity === null) throw new RunsError("not_signed_in");
  return identity;
}

export interface RunsDeps {
  db: PostgresJsDatabase;
  authenticate: AgentAuthenticator;
}

export interface RunsService {
  // Record a hook event or an MCP check-in. A run is keyed by the authenticated agent,
  // the key's workspace, and the harness's native session id; an explicit runId wins
  // when present. Concurrent clients sharing one key stay distinct; a resume reuses
  // the existing row. Absent metadata is stored as null, never guessed.
  report(request: Request, input: RunReportInput): Promise<RunReportResponse>;
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

// Repeated reports for the same child update its row in place. Attribution fields are
// nullable, so an unreported one stays null and displays as `unknown`.
async function recordChild(
  db: PostgresJsDatabase,
  runId: string,
  input: RunReportInput,
  observedAt: string,
): Promise<void> {
  const child = input.child ?? {};
  const agentId = child.agentId ?? input.agentId ?? null;
  const agentType = child.agentType ?? input.agentType ?? null;
  const childRunId = child.runId ?? null;
  const model = child.model ?? null;
  const ended = input.event === "child_ended";
  const at = new Date(observedAt);

  const [existing] = await db
    .select()
    .from(runChildren)
    .where(
      and(
        eq(runChildren.runId, runId),
        sql`coalesce(${runChildren.agentId}, '') = ${agentId ?? ""}`,
        sql`coalesce(${runChildren.agentType}, '') = ${agentType ?? ""}`,
        sql`coalesce(${runChildren.childRunId}, '') = ${childRunId ?? ""}`,
      ),
    )
    .limit(1);

  if (existing !== undefined) {
    await db
      .update(runChildren)
      .set({
        ...(model !== null ? { model } : {}),
        ...(ended
          ? { status: RunStatus.enum.ended, endedAt: at }
          : { status: RunStatus.enum.active, endedAt: null }),
      })
      .where(eq(runChildren.id, existing.id));
    return;
  }

  await db
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
    .onConflictDoNothing();
}

export function createRunsService({ db, authenticate }: RunsDeps): RunsService {
  return {
    async report(request, input) {
      const identity = await authenticateAgent(authenticate, request);
      const observedAt = input.at ?? new Date().toISOString();
      const at = new Date(observedAt);
      const reportedModel = input.model ?? null;

      // Correlation order: explicit runId, then the hook's (harness, nativeSessionId),
      // then unknown. An unknown report is accepted but records nothing — it must never
      // borrow a transport session id or collapse unrelated conversations into one run.
      let row: RunRow | undefined;
      let previousModel: string | null = null;
      let inserted = false;
      if (input.runId !== null && input.runId !== undefined) {
        [row] = await db
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.id, input.runId),
              eq(runs.agentId, identity.agentId),
              eq(runs.workspaceId, identity.workspaceId),
            ),
          )
          .limit(1);
        if (row === undefined) throw new RunsError("run_not_found");
        previousModel = row.model;
      } else if (input.runKey !== undefined) {
        // The unique index enforces identity in the database, so two concurrent
        // check-ins with the same key race safely: one inserts, the other reads the
        // winner. Two different native session ids under one key produce two runs.
        const [created] = await db
          .insert(runs)
          .values({
            id: randomUUID(),
            agentId: identity.agentId,
            workspaceId: identity.workspaceId,
            harness: input.runKey.harness,
            harnessVersion: input.harnessVersion ?? null,
            nativeSessionId: input.runKey.nativeSessionId,
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
          [row] = await db
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.agentId, identity.agentId),
                eq(runs.workspaceId, identity.workspaceId),
                eq(runs.harness, input.runKey.harness),
                eq(runs.nativeSessionId, input.runKey.nativeSessionId),
              ),
            )
            .limit(1);
        }
        if (row === undefined) throw new RunsError("run_not_found");
        previousModel = row.model;
      } else {
        return {
          runId: null,
          accepted: true,
          observedAt,
          model: reportedModel,
          harness: null,
        };
      }

      const modelChanged = reportedModel !== null && reportedModel !== previousModel;
      const updates: Partial<typeof runs.$inferInsert> = { updatedAt: at };
      if (input.harnessVersion !== null && input.harnessVersion !== undefined) {
        updates.harnessVersion = input.harnessVersion;
      }
      if (modelChanged) updates.model = reportedModel;
      if (input.event === "run_ended") {
        updates.status = RunStatus.enum.ended;
        updates.endedAt = at;
      } else if (input.event === "run_started" && row.status === RunStatus.enum.ended) {
        // A resumed conversation reuses the run and reactivates it.
        updates.status = RunStatus.enum.active;
        updates.endedAt = null;
      }
      if (input.event === "run_heartbeat" || input.checkIn !== undefined) {
        updates.lastHeartbeatAt = at;
      }
      const [updated] = await db
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
        await db.insert(runModelChanges).values({
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
        await recordChild(db, row.id, input, observedAt);
      }

      return {
        runId: row.id,
        accepted: true,
        observedAt,
        model: row.model,
        harness: row.harness,
      };
    },

    async listWorkspaceRuns(account, workspaceId) {
      const actor = requireAccount(account);
      if (!(await humanCanReadWorkspace(db, workspaceId, actor.humanId))) {
        throw new RunsError("workspace_not_found");
      }
      const found = await db
        .select()
        .from(runs)
        .where(eq(runs.workspaceId, workspaceId))
        .orderBy(desc(runs.createdAt));
      if (found.length === 0) return [];
      const ids = found.map((run) => run.id);
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
      return found.map((run): RunDetail => {
        const detail = toRun(run);
        return {
          id: detail.id,
          agentId: detail.agentId,
          workspaceId: detail.workspaceId,
          harness: detail.harness,
          harnessVersion: detail.harnessVersion,
          nativeSessionId: detail.nativeSessionId,
          model: detail.model,
          status: detail.status,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          endedAt: detail.endedAt,
          lastHeartbeatAt: detail.lastHeartbeatAt,
          modelHistory: history.get(run.id) ?? [],
          children: kids.get(run.id) ?? [],
        };
      });
    },
  };
}
