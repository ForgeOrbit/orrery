import { z } from "zod";
import { Timestamp } from "./common.ts";
import { IssuePriority, IssueStatus } from "./projects.ts";
import { QuestionStatus } from "./questions.ts";

// Cross-workspace My work (issue #99). One human-only read aggregates the three things a
// person needs to steer: their open assignments, the live sessions running under their own
// agents, and the questions waiting on them. Every item carries the workspace and project it
// came from and the human-readable <PROJECT_KEY>-<NUMBER> identifier, so a client can show a
// single list without a second lookup. The three sections are deliberately separate: they
// are scoped by different access levels and have different lifecycle rules.

// A non-deleted, non-terminal issue assigned to the signed-in human. Needs input is an
// orthogonal flag (ADR-0005), not a workflow status, so it is returned alongside status.
export const MyWorkAssignedIssue = z
  .object({
    id: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    projectKey: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    number: z.number().int().positive(),
    identifier: z.string(),
    title: z.string(),
    status: IssueStatus,
    priority: IssuePriority,
    needsInput: z.boolean(),
    updatedAt: Timestamp,
  })
  .meta({ id: "MyWorkAssignedIssue" });
export type MyWorkAssignedIssue = z.infer<typeof MyWorkAssignedIssue>;

// A live (active, unexpired) work session held by an agent owned by the signed-in human.
// Harness and model come from the run that coordinates the session, and the telemetry fields
// are null until the harness first reports them — never invented zeroes (#96).
export const MyWorkActiveSession = z
  .object({
    sessionId: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    runId: z.string(),
    harness: z.string().nullable(),
    model: z.string().nullable(),
    issueId: z.string(),
    issueIdentifier: z.string(),
    issueTitle: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    leaseExpiresAt: Timestamp,
    progress: z.string(),
    stopRequestedAt: Timestamp.nullable(),
    stopReason: z.string().nullable(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costUsdMicros: z.number().int().nonnegative().nullable(),
  })
  .meta({ id: "MyWorkActiveSession" });
export type MyWorkActiveSession = z.infer<typeof MyWorkActiveSession>;

// An open or paused question on a project where the human holds Contribute or Manage. The
// status is the database-time effective status: an open question past its deadline reads as
// paused (require_human) or resolves to fallback_used and is omitted. Answered and fallback
// questions are never actionable, so they never appear here.
export const MyWorkQuestion = z
  .object({
    id: z.string(),
    issueId: z.string(),
    issueIdentifier: z.string(),
    issueTitle: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    question: z.string(),
    status: QuestionStatus,
    responseDeadlineAt: Timestamp,
    createdAt: Timestamp,
  })
  .meta({ id: "MyWorkQuestion" });
export type MyWorkQuestion = z.infer<typeof MyWorkQuestion>;

// Success responses are the bare resource (ADR-0003): the three lists are fields of one
// object, not an MCP-style named wrapper.
export const MyWorkResponse = z
  .object({
    assignedIssues: z.array(MyWorkAssignedIssue),
    activeAgentSessions: z.array(MyWorkActiveSession),
    needsInputQuestions: z.array(MyWorkQuestion),
  })
  .meta({ id: "MyWorkResponse" });
export type MyWorkResponse = z.infer<typeof MyWorkResponse>;
