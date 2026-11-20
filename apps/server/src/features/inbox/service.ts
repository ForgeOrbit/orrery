import { randomUUID } from "node:crypto";
import {
  FallbackPolicy,
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
// predicate as the write path is projected in SQL using the effective fallback policy
// (issue override ?? project policy), so a stale row reads as paused or fallback_used.
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
  effectiveStatus: sql<string>`case when ${questions.status} = 'open' and ${questions.responseDeadlineAt} <= statement_timestamp() then case when coalesce((select ${issues.fallbackPolicyOverride} from ${issues} where ${issues.id} = ${questions.issueId}), (select ${projects.fallbackPolicy} from ${projects} where ${projects.id} = ${questions.projectId})) = 'fallback_allowed' then 'fallback_used' else 'paused' end else ${questions.status} end`,
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
  const status = QuestionStatus.parse(row.effectiveStatus ?? row.status);
  return {
    id: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    runId: row.runId,
    question: row.question,
    proposedFallback: row.proposedFallback,
    status,
    // Only a resolved fallback authorizes the proposed fallback to reach the harness.
    authorizedFallback: status === QuestionStatus.enum.fallback_used ? row.proposedFallback : null,
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

// The effective policy on the caller's already issue-locked transaction. Keeping this read
// in one place makes the deadline write, the check-in lease and a policy change's freeze of
// already-due questions decide from the same committed policy snapshot.
async function effectiveFallbackPolicy(
  tx: DbTransaction,
  issueId: string,
): Promise<FallbackPolicy> {
  const [policy] = await tx
    .select({
      override: issues.fallbackPolicyOverride,
      projectPolicy: projects.fallbackPolicy,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  return policy?.override ?? policy?.projectPolicy ?? FallbackPolicy.enum.require_human;
}

// Record the question and its resolution in the project's activity feed, which the history
// feature already exposes. The summary is the text a reader needs, never a secret.
async function recordActivity(
  tx: DbTransaction,
  input: {
    projectId: string;
    issueId: string;
    type:
      | "issue_question_asked"
      | "issue_question_answered"
      | "issue_question_paused"
      | "issue_question_fallback_used"
      | "issue_question_follow_up";
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

// A late answer to an authorized fallback is a follow-up, never a reversal: status stays
// fallback_used, Needs input and the issue's status are untouched, and the work already
// done with the fallback is not undone. The isNull guard makes a repeated answer idempotent
// by refusing a second follow-up instead of overwriting the first.
async function storeFollowUp(
  tx: DbTransaction,
  input: {
    questionId: string;
    projectId: string;
    issueId: string;
    answer: string;
    humanId: string;
  },
) {
  const [followed] = await tx
    .update(questions)
    .set({
      followUp: input.answer,
      followUpByHumanId: input.humanId,
      followUpAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(questions.id, input.questionId),
        eq(questions.status, "fallback_used"),
        isNull(questions.followUp),
      ),
    )
    .returning();
  if (followed === undefined) throw new InboxError("question_resolved");
  await recordActivity(tx, {
    projectId: input.projectId,
    issueId: input.issueId,
    type: "issue_question_follow_up",
    summary: `Follow-up on an authorized fallback: ${input.answer}`,
    humanId: input.humanId,
  });
  return followed;
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
// Two concurrent deadline evaluations cannot both resolve a question; the issue row lock
// taken by the caller serializes them, and the guard makes the transition idempotent.
// The effective policy is read on that same locked transaction: an issue override wins
// over the project policy, and only a human-set fallback_allowed authorizes the fallback.
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
  const effectivePolicy = await effectiveFallbackPolicy(tx, issueId);
  const stillDue = and(
    eq(questions.id, due.id),
    eq(questions.status, "open"),
    lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
  );

  if (effectivePolicy === FallbackPolicy.enum.fallback_allowed) {
    const [used] = await tx
      .update(questions)
      .set({ status: "fallback_used", resolvedAt: sql`statement_timestamp()` })
      .where(stillDue)
      .returning();
    if (used === undefined) return;
    // Work continues with the authorized fallback: clear Needs input so the issue is
    // ready as soon as the claim lapses, but never release a live, checking-in claim.
    // The harness only receives proposedFallback via the resolved question's
    // authorizedFallback field; an agent can never set or loosen this policy itself.
    await tx
      .update(issues)
      .set({ needsInput: false, updatedAt: sql`statement_timestamp()` })
      .where(eq(issues.id, issueId));
    await recordActivity(tx, {
      projectId: used.projectId,
      issueId,
      type: "issue_question_fallback_used",
      summary: `Authorized fallback used at the one-hour deadline: ${used.question}`,
      agentId: used.agentId,
    });
    return;
  }

  const [paused] = await tx
    .update(questions)
    .set({ status: "paused", resolvedAt: sql`statement_timestamp()` })
    .where(stillDue)
    .returning();
  if (paused === undefined) return;
  // require_human: release the live claim, keep Needs input, and leave the issue out of
  // ready work until a human unblocks it with an answer.
  await tx
    .update(workSessions)
    .set({
      status: "released",
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(and(eq(workSessions.issueId, issueId), eq(workSessions.status, "active")));
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
  if (row === undefined) return null;
  // Only require_human clips a check-in's lease to the response deadline. Under
  // fallback_allowed the worker keeps its normal five-minute lease across the boundary:
  // the deadline evaluation runs first on the same locked transaction and resolves the
  // question to fallback_used without releasing that still-live claim. A later tightening
  // to require_human is still enforced by evaluateDeadline at the deadline itself.
  return (await effectiveFallbackPolicy(tx, issueId)) === FallbackPolicy.enum.require_human
    ? row.responseDeadlineAt
    : null;
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
        // that races the boundary first pauses (require_human, releasing the claim) or
        // resolves to fallback_used (fallback_allowed). In the latter case the answer is
        // recorded as a follow-up, never as an on-time answer.
        await evaluateDeadline(tx, issue.id);
        const freshRow = async () => {
          const [fresh] = await tx
            .select()
            .from(questions)
            .where(eq(questions.id, questionId))
            .limit(1)
            .for("update");
          if (fresh === undefined) throw new InboxError("question_not_found");
          return fresh;
        };
        const followUp = () =>
          storeFollowUp(tx, {
            questionId,
            projectId: issue.projectId,
            issueId: issue.id,
            answer,
            humanId: actor.account.humanId,
          });
        const row = await freshRow();
        if (row.status === "answered") throw new InboxError("question_resolved");
        if (row.status === "fallback_used") return toQuestion(await followUp());
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
                // in database time; at/after it the deadline must resolve first.
                or(
                  gt(questions.responseDeadlineAt, sql`statement_timestamp()`),
                  eq(questions.status, "paused"),
                ),
              ),
            )
            .returning();
        const [first] = await resolveAnswered();
        let answered = first;
        if (answered === undefined) {
          // The deadline can land between the evaluation and this statement. Re-evaluate,
          // then re-read: under fallback_allowed the answer becomes a follow-up; under
          // require_human the now-paused question is resolved instead of a spurious 409.
          await evaluateDeadline(tx, issue.id);
          const retried = await freshRow();
          if (retried.status === "fallback_used") return toQuestion(await followUp());
          if (retried.status === "answered") throw new InboxError("question_resolved");
          if (retried.status === "paused" || retried.status === "open") {
            const [resolved] = await resolveAnswered();
            answered = resolved;
          }
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
            .where(eq(workspaceMemberships.humanId, humanId));
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
