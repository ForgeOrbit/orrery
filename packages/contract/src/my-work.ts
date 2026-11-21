import { z } from "zod";
import { Timestamp } from "./common.ts";
import { IssuePriority, IssueStatus } from "./projects.ts";
import { QuestionStatus } from "./questions.ts";










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



export const MyWorkResponse = z
  .object({
    assignedIssues: z.array(MyWorkAssignedIssue),
    activeAgentSessions: z.array(MyWorkActiveSession),
    needsInputQuestions: z.array(MyWorkQuestion),
  })
  .meta({ id: "MyWorkResponse" });
export type MyWorkResponse = z.infer<typeof MyWorkResponse>;
