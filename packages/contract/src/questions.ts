import { z } from "zod";
import { Timestamp } from "./common.ts";

// Human input through the inbox (issue #41, user stories 58-61 and 66-68). A question is
// asked by an agent that holds a claim, and resolved exactly once in database time. The
// three outcomes are deliberately distinct: `answered` (a human answered before the
// deadline, or later unblocked a paused question), `paused` (no fallback was authorized at
// the one-hour deadline, so the claim is released and the issue stays Needs input) and
// `fallback_used` (reserved for #42, where an authorized fallback lets work continue). A
// human answer after `fallback_used` is a `follow_up`: it never reverses work already done.

export const QuestionStatus = z
  .enum(["open", "answered", "paused", "fallback_used"])
  .meta({ id: "QuestionStatus" });
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const Question = z
  .object({
    id: z.string(),
    issueId: z.string(),
    projectId: z.string(),
    workspaceId: z.string(),
    agentId: z.string(),
    runId: z.string(),
    question: z.string(),
    proposedFallback: z.string(),
    status: QuestionStatus,
    // Database time, one hour after the question was opened. The boundary is inclusive:
    // an answer is on time only while statement_timestamp() < responseDeadlineAt.
    responseDeadlineAt: Timestamp,
    answer: z.string().nullable(),
    answeredByHumanId: z.string().nullable(),
    answeredAt: Timestamp.nullable(),
    // A late answer to a question whose fallback was used (#42) is stored here, without
    // changing the resolution or clearing Needs input. In #41 no fallback is authorized,
    // so this stays null; the field exists so #42 needs no data migration.
    followUp: z.string().nullable(),
    followUpByHumanId: z.string().nullable(),
    followUpAt: Timestamp.nullable(),
    resolvedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "Question" });
export type Question = z.infer<typeof Question>;

export const QuestionResponse = z.object({ question: Question }).meta({ id: "QuestionResponse" });
export type QuestionResponse = z.infer<typeof QuestionResponse>;

export const InboxResponse = z.array(Question).meta({ id: "InboxResponse" });
export type InboxResponse = z.infer<typeof InboxResponse>;

// The agent proposes a concrete fallback, but never authorizes it: #42 decides whether
// project/issue policy allows it. In #41 no fallback is authorized, so the deadline pauses.
export const AskForInputInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(20_000),
    proposedFallback: z.string().trim().min(1).max(20_000),
  })
  .meta({ id: "AskForInputInput" });
export type AskForInputInput = z.infer<typeof AskForInputInput>;

export const AnswerQuestionInput = z
  .object({ answer: z.string().trim().min(1).max(20_000) })
  .meta({ id: "AnswerQuestionInput" });
export type AnswerQuestionInput = z.infer<typeof AnswerQuestionInput>;

export const QuestionParams = z
  .object({ questionId: z.string().min(1).max(200) })
  .meta({ id: "QuestionParams" });
export type QuestionParams = z.infer<typeof QuestionParams>;

export const IssueQuestionParams = z
  .object({ issueId: z.string().min(1).max(200) })
  .meta({ id: "IssueQuestionParams" });
export type IssueQuestionParams = z.infer<typeof IssueQuestionParams>;
