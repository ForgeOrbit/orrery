import {
  ProjectAccessLevel,
  QuestionStatus,
  TERMINAL_ISSUE_STATUSES,
  type MyWorkResponse,
} from "@orrery/contract";
import { and, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agents,
  humans,
  issues,
  projects,
  questions,
  runs,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionAccount } from "../accounts/index.ts";

// My work (issue #99) is one read-only decision: what the signed-in human can act on right
// now, across their personal workspace and every shared workspace where they still hold an
// active membership. REST only resolves the cookie and maps errors; every scope decision is
// here, reusing projects' one access resolver so a revoked grant or a suspended membership
// excludes data on the very next request.

export type MyWorkErrorKind = "not_signed_in" | "human_deactivated";

const messages: Record<MyWorkErrorKind, string> = {
  not_signed_in: "Sign in as a human to see My work.",
  human_deactivated: "This account is deactivated.",
};

export class MyWorkError extends Error {
  readonly kind: MyWorkErrorKind;

  constructor(kind: MyWorkErrorKind) {
    super(messages[kind]);
    this.name = "MyWorkError";
    this.kind = kind;
  }
}

export type MyWorkProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export interface MyWorkDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: MyWorkProjectAccessCeiling;
  projectAccessAtLeast: (actual: ProjectAccessLevel, required: ProjectAccessLevel) => boolean;
}

export interface MyWorkService {
  get(actor: SessionAccount | null): Promise<MyWorkResponse>;
}

// The same database-time projection as inbox/service.ts: an open question past its deadline
// is not really open any more. With require_human it reads as paused (still actionable here);
// with fallback_allowed it has resolved to fallback_used and must never appear. Answered and
// already-fallback questions project to themselves and are filtered out by the same WHERE.
const effectiveQuestionStatus = sql<string>`case when ${questions.status} = 'open' and ${questions.responseDeadlineAt} <= statement_timestamp() then case when coalesce(${issues.fallbackPolicyOverride}, ${projects.fallbackPolicy}) = 'fallback_allowed' then 'fallback_used' else 'paused' end else ${questions.status} end`;

// A single screen, not a feed: bound each section so one busy workspace cannot crowd out the
// others. Scoping happens first, per workspace, so a global LIMIT could never hide a whole
// workspace's work.
const PAGE = 200;

const byNewest = (a: string, b: string) => b.localeCompare(a);

export function createMyWorkService(deps: MyWorkDeps): MyWorkService {
  return {
    async get(actor) {
      if (actor === null) throw new MyWorkError("not_signed_in");

      return deps.db.transaction(
        async (tx) => {
          // Recheck in the read transaction: a retained cookie is resolved by accounts
          // already, but a deactivated account must lose access even to a stale actor object.
          const [human] = await tx
            .select({ id: humans.id, deactivatedAt: humans.deactivatedAt })
            .from(humans)
            .where(eq(humans.id, actor.humanId))
            .limit(1);
          if (human === undefined) throw new MyWorkError("not_signed_in");
          if (human.deactivatedAt !== null) throw new MyWorkError("human_deactivated");

          // Personal workspaces have no membership row. Shared ones require a membership
          // whose suspension is still null — a removed or suspended member sees nothing.
          const personal = await tx
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.personalOwnerHumanId, actor.humanId));
          const shared = await tx
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .innerJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, workspaces.id),
                eq(workspaceMemberships.humanId, actor.humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            );
          const scopes = [
            ...new Map([...personal, ...shared].map((row) => [row.id, row])).values(),
          ];

          const assignedIssues: MyWorkResponse["assignedIssues"] = [];
          const activeAgentSessions: MyWorkResponse["activeAgentSessions"] = [];
          const needsInputQuestions: MyWorkResponse["needsInputQuestions"] = [];

          for (const scope of scopes) {
            const scopeProjects = await tx
              .select({ id: projects.id, name: projects.name, key: projects.key })
              .from(projects)
              .where(eq(projects.workspaceId, scope.id));
            if (scopeProjects.length === 0) continue;

            // One resolver for every level: personal owner, shared owner, explicit grant.
            // It reads current workspaces, memberships and grants inside this transaction.
            const ceiling = await deps.projectAccessCeiling(
              tx,
              scope.id,
              actor.humanId,
              scopeProjects.map((row) => row.id),
            );
            const levelOf = (projectId: string) => ceiling.get(projectId) ?? null;
            const readable = scopeProjects
              .filter((row) => {
                const level = levelOf(row.id);
                return (
                  level !== null && deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read)
                );
              })
              .map((row) => row.id);
            if (readable.length === 0) continue;
            const actionable = new Set(
              scopeProjects
                .filter((row) => {
                  const level = levelOf(row.id);
                  return (
                    level !== null &&
                    deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.contribute)
                  );
                })
                .map((row) => row.id),
            );
            const projectKey = new Map(scopeProjects.map((row) => [row.id, row.key]));

            // 1. Non-deleted, non-terminal issues assigned to this human.
            const assigned = await tx
              .select({
                id: issues.id,
                projectId: issues.projectId,
                projectName: projects.name,
                number: issues.number,
                title: issues.title,
                status: issues.status,
                priority: issues.priority,
                needsInput: issues.needsInput,
                updatedAt: issues.updatedAt,
              })
              .from(issues)
              .innerJoin(projects, eq(projects.id, issues.projectId))
              .where(
                and(
                  inArray(issues.projectId, readable),
                  eq(issues.assigneeType, "human"),
                  eq(issues.assigneeId, actor.humanId),
                  isNull(issues.deletedAt),
                  notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
                ),
              )
              .orderBy(desc(issues.updatedAt))
              .limit(PAGE);
            assignedIssues.push(
              ...assigned.map((row) => ({
                id: row.id,
                projectId: row.projectId,
                projectName: row.projectName,
                projectKey: projectKey.get(row.projectId) ?? "",
                workspaceId: scope.id,
                workspaceName: scope.name,
                number: row.number,
                identifier: `${projectKey.get(row.projectId) ?? ""}-${row.number}`,
                title: row.title,
                status: row.status,
                priority: row.priority,
                needsInput: row.needsInput,
                updatedAt: row.updatedAt.toISOString(),
              })),
            );

            // 2. Live sessions under agents this human owns, on readable non-deleted issues.
            // The lease check is database time: a lapsed lease never appears here.
            const liveSessions = await tx
              .select({
                id: workSessions.id,
                agentId: workSessions.agentId,
                agentName: agents.name,
                runId: workSessions.runId,
                harness: runs.harness,
                model: runs.model,
                issueId: issues.id,
                issueNumber: issues.number,
                issueTitle: issues.title,
                issueProjectId: issues.projectId,
                projectName: projects.name,
                leaseExpiresAt: workSessions.leaseExpiresAt,
                progress: workSessions.progress,
                stopRequestedAt: workSessions.stopRequestedAt,
                stopReason: workSessions.stopReason,
                inputTokens: workSessions.inputTokens,
                outputTokens: workSessions.outputTokens,
                costUsdMicros: workSessions.costUsdMicros,
              })
              .from(workSessions)
              .innerJoin(agents, eq(agents.id, workSessions.agentId))
              .innerJoin(runs, eq(runs.id, workSessions.runId))
              .innerJoin(issues, eq(issues.id, workSessions.issueId))
              .innerJoin(projects, eq(projects.id, issues.projectId))
              .where(
                and(
                  eq(workSessions.workspaceId, scope.id),
                  eq(agents.humanId, actor.humanId),
                  eq(workSessions.status, "active"),
                  gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
                  isNull(issues.deletedAt),
                  inArray(issues.projectId, readable),
                ),
              )
              .orderBy(desc(workSessions.createdAt))
              .limit(PAGE);
            activeAgentSessions.push(
              ...liveSessions.map((row) => ({
                sessionId: row.id,
                agentId: row.agentId,
                agentName: row.agentName,
                runId: row.runId,
                harness: row.harness,
                model: row.model,
                issueId: row.issueId,
                issueIdentifier: `${projectKey.get(row.issueProjectId) ?? ""}-${row.issueNumber}`,
                issueTitle: row.issueTitle,
                projectId: row.issueProjectId,
                projectName: row.projectName,
                workspaceId: scope.id,
                workspaceName: scope.name,
                leaseExpiresAt: row.leaseExpiresAt.toISOString(),
                progress: row.progress,
                stopRequestedAt: row.stopRequestedAt?.toISOString() ?? null,
                stopReason: row.stopReason,
                inputTokens: row.inputTokens,
                outputTokens: row.outputTokens,
                costUsdMicros: row.costUsdMicros,
              })),
            );

            // 3. Open or paused questions on non-deleted issues the human may contribute to.
            if (actionable.size > 0) {
              const pending = await tx
                .select({
                  id: questions.id,
                  issueId: questions.issueId,
                  issueNumber: issues.number,
                  issueTitle: issues.title,
                  issueProjectId: issues.projectId,
                  projectName: projects.name,
                  agentId: questions.agentId,
                  agentName: agents.name,
                  question: questions.question,
                  status: effectiveQuestionStatus,
                  responseDeadlineAt: questions.responseDeadlineAt,
                  createdAt: questions.createdAt,
                })
                .from(questions)
                .innerJoin(issues, eq(issues.id, questions.issueId))
                .innerJoin(projects, eq(projects.id, questions.projectId))
                .innerJoin(agents, eq(agents.id, questions.agentId))
                .where(
                  and(
                    eq(questions.workspaceId, scope.id),
                    inArray(questions.projectId, [...actionable]),
                    isNull(issues.deletedAt),
                    sql`${effectiveQuestionStatus} in ('open', 'paused')`,
                  ),
                )
                .orderBy(desc(questions.createdAt))
                .limit(PAGE);
              needsInputQuestions.push(
                ...pending.map((row) => ({
                  id: row.id,
                  issueId: row.issueId,
                  issueIdentifier: `${projectKey.get(row.issueProjectId) ?? ""}-${row.issueNumber}`,
                  issueTitle: row.issueTitle,
                  projectId: row.issueProjectId,
                  projectName: row.projectName,
                  workspaceId: scope.id,
                  workspaceName: scope.name,
                  agentId: row.agentId,
                  agentName: row.agentName,
                  question: row.question,
                  status: QuestionStatus.parse(row.status),
                  responseDeadlineAt: row.responseDeadlineAt.toISOString(),
                  createdAt: row.createdAt.toISOString(),
                })),
              );
            }
          }

          return {
            assignedIssues: assignedIssues
              .toSorted((a, b) => byNewest(a.updatedAt, b.updatedAt))
              .slice(0, PAGE),
            activeAgentSessions: activeAgentSessions
              .toSorted((a, b) => byNewest(a.leaseExpiresAt, b.leaseExpiresAt))
              .slice(0, PAGE),
            needsInputQuestions: needsInputQuestions
              .toSorted((a, b) => byNewest(a.createdAt, b.createdAt))
              .slice(0, PAGE),
          };
        },
        { accessMode: "read only" },
      );
    },
  };
}
