import { randomUUID } from "node:crypto";
import {
  ProjectAccessLevel,
  QuestionStatus,
  type AgentIdentity,
  type Question,
} from "@orrery/contract";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  agents,
  humans,
  issues,
  projectActivity,
  projects,
  questions,
  runs,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { Logger } from "../../platform/log.ts";
import type { OutgoingMail } from "../settings/index.ts";
import type { WorkActor } from "../projects/index.ts";
import { decideQuestionAnswer, questionMachine } from "./state-machine.ts";

// The service is the only file that decides anything for human input (#41). REST and MCP
// authenticate, validate, and map results: every access decision, deadline evaluation and
// resolution transition happens here, in one transaction that locks the issue row first.

export type InboxErrorKind =
  | "not_signed_in"
  | "agents_cannot_use_inbox"
  | "agents_cannot_answer"
  | "issue_not_found"
  | "project_not_found"
  | "run_not_found"
  | "session_required"
  | "insufficient_access"
  | "question_not_found"
  | "question_open"
  | "question_not_open"
  | "question_resolved";

const messages: Record<InboxErrorKind, string> = {
  not_signed_in: "Sign in as a human to use the inbox.",
  agents_cannot_use_inbox: "Only humans may use the inbox.",
  agents_cannot_answer: "Only humans may answer a question; agents and sibling runs cannot.",
  issue_not_found: "No such issue is in scope for this agent.",
  project_not_found: "No such project is in scope for the caller.",
  run_not_found: "No such run belongs to this agent in this workspace.",
  session_required: "This agent holds no live session for this issue.",
  insufficient_access: "Contribute access is required to answer questions on this project.",
  question_not_found: "No such question is in scope for the caller.",
  question_open: "This issue already has an open question.",
  question_not_open: "Only an open issue can be asked about.",
  question_resolved: "This question has already been resolved.",
};

export class InboxError extends Error {
  readonly kind: InboxErrorKind;

  constructor(kind: InboxErrorKind) {
    super(messages[kind]);
    this.name = "InboxError";
    this.kind = kind;
  }
}

export type InboxProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export interface InboxDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: InboxProjectAccessCeiling;
  projectAccessAtLeast: (actual: ProjectAccessLevel, required: ProjectAccessLevel) => boolean;
  // Settings' one mail sender. Called only after the question transaction commits, so a
  // relay failure never rolls back a question or leaves a half-written resolution.
  deliver: (mail: OutgoingMail) => Promise<void>;
  log: Logger;
}

export type AgentActor = { kind: "agent"; identity: AgentIdentity };

export interface InboxService {
  ask(
    actor: AgentActor | null,
    input: { issueId: string; runId: string; question: string; proposedFallback: string },
  ): Promise<Question>;
  answer(actor: WorkActor | null, questionId: string, answer: string): Promise<Question>;
  list(actor: WorkActor | null): Promise<Question[]>;
  issueHistory(actor: WorkActor | null, issueId: string): Promise<Question[]>;
  // Narrow seams borrowed by work sessions, executed on the caller's already issue-locked
  // transaction. Neither opens a nested transaction.
  questionDeadline(tx: DbTransaction, issueId: string): Promise<Date | null>;
  evaluateDeadline(tx: DbTransaction, issueId: string): Promise<void>;
}

type QuestionRow = typeof questions.$inferSelect;
type QuestionView = Omit<QuestionRow, "sessionId"> & { effectiveStatus?: string };

// Reads must never show an open question past the one-hour deadline: the same DB-time
// predicate as the write path is projected in SQL, so a stale row reads as paused.
const questionColumns = {
  id: questions.id,
  issueId: questions.issueId,
  projectId: questions.projectId,
  workspaceId: questions.workspaceId,
  agentId: questions.agentId,
  runId: questions.runId,
  question: questions.question,
  proposedFallback: questions.proposedFallback,
  status: questions.status,
  effectiveStatus: sql<string>`case when ${questions.status} = 'open' and ${questions.responseDeadlineAt} <= statement_timestamp() then 'paused' else ${questions.status} end`,
  responseDeadlineAt: questions.responseDeadlineAt,
  answer: questions.answer,
  answeredByHumanId: questions.answeredByHumanId,
  answeredAt: questions.answeredAt,
  followUp: questions.followUp,
  followUpByHumanId: questions.followUpByHumanId,
  followUpAt: questions.followUpAt,
  resolvedAt: questions.resolvedAt,
  createdAt: questions.createdAt,
};

const iso = (value: Date | null) => value?.toISOString() ?? null;

function toQuestion(row: QuestionView): Question {
  return {
    id: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    runId: row.runId,
    question: row.question,
    proposedFallback: row.proposedFallback,
    status: QuestionStatus.parse(row.effectiveStatus ?? row.status),
    responseDeadlineAt: row.responseDeadlineAt.toISOString(),
    answer: row.answer,
    answeredByHumanId: row.answeredByHumanId,
    answeredAt: iso(row.answeredAt),
    followUp: row.followUp,
    followUpByHumanId: row.followUpByHumanId,
    followUpAt: iso(row.followUpAt),
    resolvedAt: iso(row.resolvedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

// Lock the issue first on every state change. Every writer of questions.needs_input goes
// through this lock, so a deadline evaluation and an answer serialize on one row.
async function lockIssue(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select({
      id: issues.id,
      projectId: issues.projectId,
      title: issues.title,
      number: issues.number,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .for("update");
  if (row === undefined) throw new InboxError("issue_not_found");
  return row;
}

// Record the question and its resolution in the project's activity feed, which the history
// feature already exposes. The summary is the text a reader needs, never a secret.
async function recordActivity(
  tx: DbTransaction,
  input: {
    projectId: string;
    issueId: string;
    type: "issue_question_asked" | "issue_question_answered" | "issue_question_paused";
    summary: string;
    agentId?: string;
    humanId?: string;
  },
) {
  await tx.insert(projectActivity).values({
    id: randomUUID(),
    projectId: input.projectId,
    type: input.type,
    issueId: input.issueId,
    summary: input.summary,
    actorAgentId: input.agentId ?? null,
    actorHumanId: input.humanId ?? null,
    createdAt: sql`statement_timestamp()`,
  });
}

function humanIdOf(actor: WorkActor): string {
  if (actor.kind === "human") return actor.account.humanId;
  throw new InboxError("agents_cannot_use_inbox");
}

// An agent's effective level is capped by its human owner's *current* project access, so a
// downgrade or removal stops a question immediately. A human actor uses its own level.
async function requireAccess(
  tx: DbTransaction,
  actor: WorkActor,
  projectId: string,
  required: ProjectAccessLevel,
  deps: InboxDeps,
  missing: "issue_not_found" | "project_not_found" | "question_not_found",
) {
  const [project] = await tx
    .select({ id: projects.id, workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (
    project === undefined ||
    (actor.kind === "agent" && project.workspaceId !== actor.identity.workspaceId)
  ) {
    throw new InboxError(missing);
  }
  const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;
  const ceiling = await deps.projectAccessCeiling(tx, project.workspaceId, humanId, [projectId]);
  const humanLevel = ceiling.get(projectId) ?? null;
  let effective = humanLevel;
  if (actor.kind === "agent") {
    const keyLevel = actor.identity.projects.find((grant) => grant.projectId === projectId)?.level;
    if (keyLevel === undefined) throw new InboxError(missing);
    effective =
      humanLevel === null
        ? null
        : deps.projectAccessAtLeast(humanLevel, keyLevel)
          ? keyLevel
          : humanLevel;
  }
  // No access at all means the caller must not learn that the project, issue or question
  // exists: answer 404 with the feature's non-enumeration code. Only a caller who *has*
  // Read but lacks the required level (a Reader asked to Contribute) gets a 403.
  if (effective === null) throw new InboxError(missing);
  if (!deps.projectAccessAtLeast(effective, required)) {
    throw new InboxError("insufficient_access");
  }
  return project;
}

function requireAgent(actor: AgentActor | null): AgentIdentity {
  if (actor === null) throw new InboxError("not_signed_in");
  return actor.identity;
}

// The deadline and the resolution are decided in one conditional UPDATE in database time.
// Two concurrent deadline evaluations cannot both pause a question; the issue row lock
// taken by the caller serializes them, and the guard makes the transition idempotent.
const evaluateDeadline: InboxService["evaluateDeadline"] = async (tx, issueId) => {
  const [due] = await tx
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.issueId, issueId),
        eq(questions.status, "open"),
        lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  if (due === undefined) return;
  questionMachine.assertTransition("open", "paused");
  const [paused] = await tx
    .update(questions)
    .set({
      status: "paused",
      resolvedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(questions.id, due.id),
        eq(questions.status, "open"),
        lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
      ),
    )
    .returning();
  if (paused === undefined) return;
  // #41 has no authorized fallback, so the one-hour deadline pauses: materialize any
  // already-lapsed session as 'expired' (preserving its terminal expiry for resume/reacquire)
  // and release only a still-live claim, keeping Needs input set until a human answers.
  await tx
    .update(workSessions)
    .set({
      status: "expired",
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, "active"),
        lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    );
  await tx
    .update(workSessions)
    .set({
      status: "released",
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, "active"),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    );
  await tx
    .update(issues)
    .set({ needsInput: true, updatedAt: sql`statement_timestamp()` })
    .where(eq(issues.id, issueId));
  await recordActivity(tx, {
    projectId: paused.projectId,
    issueId,
    type: "issue_question_paused",
    summary: `Question paused at the one-hour deadline: ${paused.question}`,
    agentId: paused.agentId,
  });
};

const questionDeadline: InboxService["questionDeadline"] = async (tx, issueId) => {
  const [row] = await tx
    .select({ responseDeadlineAt: questions.responseDeadlineAt })
    .from(questions)
    .where(and(eq(questions.issueId, issueId), eq(questions.status, "open")))
    .limit(1);
  return row?.responseDeadlineAt ?? null;
};

export function createInboxService(deps: InboxDeps): InboxService {
  const { db } = deps;

  return {
    async ask(actorArg, input) {
      const identity = requireAgent(actorArg);
      const actor: WorkActor = { kind: "agent", identity };
      // Lock the issue, evaluate any due deadline, then decide the ask in DB time.
      const outcome = await db.transaction(async (tx) => {
        const issue = await lockIssue(tx, input.issueId);
        await evaluateDeadline(tx, issue.id);
        await requireAccess(
          tx,
          actor,
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          deps,
          "issue_not_found",
        );
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
        if (run === undefined) throw new InboxError("run_not_found");
        if (issue.status !== "open") throw new InboxError("question_not_open");
        const [session] = await tx
          .select({ id: workSessions.id })
          .from(workSessions)
          .where(
            and(
              eq(workSessions.issueId, issue.id),
              eq(workSessions.runId, input.runId),
              eq(workSessions.agentId, identity.agentId),
              eq(workSessions.workspaceId, identity.workspaceId),
              eq(workSessions.status, "active"),
              gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
            ),
          )
          .limit(1);
        if (session === undefined) throw new InboxError("session_required");
        const [existing] = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(eq(questions.issueId, issue.id), sql`${questions.status} in ('open', 'paused')`),
          )
          .limit(1);
        if (existing !== undefined) throw new InboxError("question_open");
        const [created] = await tx
          .insert(questions)
          .values({
            id: randomUUID(),
            issueId: issue.id,
            projectId: issue.projectId,
            workspaceId: identity.workspaceId,
            agentId: identity.agentId,
            runId: input.runId,
            sessionId: session.id,
            question: input.question,
            proposedFallback: input.proposedFallback,
            status: "open",
            responseDeadlineAt: sql`statement_timestamp() + interval '1 hour'`,
            createdAt: sql`statement_timestamp()`,
          })
          .returning();
        if (created === undefined) throw new InboxError("question_open");
        await tx
          .update(issues)
          .set({ needsInput: true, updatedAt: sql`statement_timestamp()` })
          .where(eq(issues.id, issue.id));
        await recordActivity(tx, {
          projectId: issue.projectId,
          issueId: issue.id,
          type: "issue_question_asked",
          summary: `Question asked: ${input.question}`,
          agentId: identity.agentId,
        });
        const [owner] = await tx
          .select({ email: humans.email, name: agents.name })
          .from(agents)
          .innerJoin(humans, eq(humans.id, agents.humanId))
          .where(eq(agents.id, identity.agentId))
          .limit(1);
        return {
          question: toQuestion(created),
          ownerEmail: owner?.email ?? null,
          agentName: owner?.name ?? identity.agentId,
          issueTitle: issue.title,
          issueNumber: issue.number,
        };
      });
      // Email only after commit, outside the DB lock. A relay failure is logged, never
      // allowed to roll back the question or to leak the relay secret into the log.
      if (outcome.ownerEmail !== null) {
        try {
          await deps.deliver({
            to: outcome.ownerEmail,
            subject: `Orrery: input needed on #${outcome.issueNumber} ${outcome.issueTitle}`,
            text: [
              `${outcome.agentName} asked for input on issue #${outcome.issueNumber} (${outcome.issueTitle}).`,
              "",
              outcome.question.question,
              "",
              `Proposed fallback: ${outcome.question.proposedFallback}`,
              "",
              `Answer it in the Orrery inbox before ${outcome.question.responseDeadlineAt}.`,
            ].join("\n"),
          });
        } catch (error) {
          deps.log.warn("input notification email was not delivered", {
            questionId: outcome.question.id,
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      return outcome.question;
    },

    async answer(actorArg, questionId, answer) {
      const actor = actorArg;
      if (actor === null) throw new InboxError("not_signed_in");
      if (actor.kind === "agent") throw new InboxError("agents_cannot_answer");
      return db.transaction(async (tx) => {
        const [found] = await tx
          .select({ issueId: questions.issueId })
          .from(questions)
          .where(eq(questions.id, questionId))
          .limit(1);
        if (found === undefined) throw new InboxError("question_not_found");
        const issue = await lockIssue(tx, found.issueId);
        await requireAccess(
          tx,
          actor,
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          deps,
          "question_not_found",
        );
        // Evaluate the deadline in database time before reading the resolution: an answer
        // that races the boundary first pauses (releasing the claim), then unblocks.
        await evaluateDeadline(tx, issue.id);
        const [row] = await tx
          .select()
          .from(questions)
          .where(eq(questions.id, questionId))
          .limit(1)
          .for("update");
        if (row === undefined) throw new InboxError("question_not_found");
        const answerAction = decideQuestionAnswer(row.status, row.followUp !== null);
        if (answerAction === "already_resolved") throw new InboxError("question_resolved");
        if (answerAction === "record_follow_up") {
          // #42 territory: a late answer is a follow-up, never a reversal of fallback work.
          const [followed] = await tx
            .update(questions)
            .set({
              followUp: answer,
              followUpByHumanId: actor.account.humanId,
              followUpAt: sql`statement_timestamp()`,
            })
            .where(
              and(
                eq(questions.id, questionId),
                eq(questions.status, "fallback_used"),
                isNull(questions.followUp),
              ),
            )
            .returning();
          if (followed === undefined) throw new InboxError("question_resolved");
          return toQuestion(followed);
        }
        questionMachine.assertTransition(row.status, "answered");
        // Exactly one conditional update wins: open (before the deadline) or paused (after
        // a deadline pause) becomes answered. Two concurrent answers serialize on the
        // issue row lock and the guard; only one can transition the question.
        const resolveAnswered = () =>
          tx
            .update(questions)
            .set({
              status: "answered",
              answer,
              answeredByHumanId: actor.account.humanId,
              answeredAt: sql`statement_timestamp()`,
              resolvedAt: sql`statement_timestamp()`,
            })
            .where(
              and(
                eq(questions.id, questionId),
                sql`${questions.status} in ('open', 'paused')`,
                // An open question is answered directly only strictly before the deadline
                // in database time; at/after it the deadline pause must release the claim.
                or(
                  gt(questions.responseDeadlineAt, sql`statement_timestamp()`),
                  eq(questions.status, "paused"),
                ),
              ),
            )
            .returning();
        const [first] = await resolveAnswered();
        let answered = first;
        if (answered === undefined && row.status === "open") {
          // The deadline can land between the evaluation and this statement. Pause first,
          // then resolve the now-paused question instead of returning a spurious 409.
          await evaluateDeadline(tx, issue.id);
          const [retried] = await resolveAnswered();
          answered = retried;
        }
        if (answered === undefined) throw new InboxError("question_resolved");
        // Clears Needs input whether the claim is still held (continue) or lapsed/released
        // at the deadline (resume after reacquisition). We never reacquire a claim here.
        await tx
          .update(issues)
          .set({ needsInput: false, updatedAt: sql`statement_timestamp()` })
          .where(eq(issues.id, issue.id));
        await recordActivity(tx, {
          projectId: issue.projectId,
          issueId: issue.id,
          type: "issue_question_answered",
          summary: `Question answered: ${answer}`,
          humanId: actor.account.humanId,
        });
        return toQuestion(answered);
      });
    },

    async list(actorArg) {
      if (actorArg === null) throw new InboxError("not_signed_in");
      if (actorArg.kind === "agent") throw new InboxError("agents_cannot_use_inbox");
      const humanId = humanIdOf(actorArg);
      return db.transaction(
        async (tx) => {
          // Scope to this human's workspaces first: a global LIMIT would let a busy workspace
          // hide another workspace's inbox. One postgres.js transaction is a single connection,
          // so the per-workspace access queries run sequentially, never via Promise.all.
          const personal = await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.personalOwnerHumanId, humanId));
          const memberships = await tx
            .select({ workspaceId: workspaceMemberships.workspaceId })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.humanId, humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            );
          const workspaceIds = [
            ...new Set([
              ...personal.map((row) => row.id),
              ...memberships.map((row) => row.workspaceId),
            ]),
          ];
          const visible: QuestionView[] = [];
          for (const workspaceId of workspaceIds) {
            const candidates = await tx
              .selectDistinct({ projectId: questions.projectId })
              .from(questions)
              .where(eq(questions.workspaceId, workspaceId));
            const projectIds = candidates.map((row) => row.projectId);
            if (projectIds.length === 0) continue;
            const ceiling = await deps.projectAccessCeiling(tx, workspaceId, humanId, projectIds);
            // Readers can see the question and its resolution; only Contribute or Manage may
            // answer, and that stricter rule is enforced by the answer endpoint itself.
            const readable = projectIds.filter((projectId) => {
              const level = ceiling.get(projectId) ?? null;
              return (
                level !== null && deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read)
              );
            });
            if (readable.length === 0) continue;
            const rows = await tx
              .select(questionColumns)
              .from(questions)
              .where(
                and(eq(questions.workspaceId, workspaceId), inArray(questions.projectId, readable)),
              )
              .orderBy(desc(questions.createdAt))
              .limit(200);
            visible.push(...rows);
          }
          visible.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return visible.slice(0, 200).map(toQuestion);
        },
        { accessMode: "read only" },
      );
    },

    async issueHistory(actorArg, issueId) {
      if (actorArg === null) throw new InboxError("not_signed_in");
      return db.transaction(
        async (tx) => {
          const [issue] = await tx
            .select({ projectId: issues.projectId })
            .from(issues)
            .where(eq(issues.id, issueId))
            .limit(1);
          if (issue === undefined) throw new InboxError("issue_not_found");
          await requireAccess(
            tx,
            actorArg,
            issue.projectId,
            ProjectAccessLevel.enum.read,
            deps,
            "issue_not_found",
          );
          const rows = await tx
            .select(questionColumns)
            .from(questions)
            .where(eq(questions.issueId, issueId))
            .orderBy(desc(questions.createdAt));
          return rows.map(toQuestion);
        },
        { accessMode: "read only" },
      );
    },

    questionDeadline,
    evaluateDeadline,
  };
}
