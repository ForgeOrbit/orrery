import { z } from "zod";
import { Timestamp } from "./common.ts";
import { Issue } from "./projects.ts";

// Work sessions and renewable claims (issue #36, user stories 51-54 and 57). A session
// belongs to an agent, a run, a workspace and an issue — never to one API key. Two keys
// for the same agent during rotation therefore act on the same session. The lease is a
// five-minute reservation in database time; progress is stored separately from the lease
// so an interruption never erases it.

export const WorkSessionStatus = z
  .enum(["active", "completed", "released", "expired"])
  .meta({ id: "WorkSessionStatus" });
export type WorkSessionStatus = z.infer<typeof WorkSessionStatus>;

// The stop outcome releases the claim. "completed" is the normal stop; "released" is the
// explicit give-up that leaves the issue open for another worker. Both end the session.
export const WorkSessionOutcome = z
  .enum(["completed", "released"])
  .meta({ id: "WorkSessionOutcome" });
export type WorkSessionOutcome = z.infer<typeof WorkSessionOutcome>;

export const WorkSession = z
  .object({
    id: z.string(),
    agentId: z.string(),
    runId: z.string(),
    workspaceId: z.string(),
    issueId: z.string(),
    status: WorkSessionStatus,
    // The reservation's deadline, in database time. An active session with a deadline at
    // or before "now" is stale; the service expires it lazily on the next relevant write.
    leaseExpiresAt: Timestamp,
    // Progress is independent of the lease: expiry only changes status, never this text.
    progress: z.string(),
    progressUpdatedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .meta({ id: "WorkSession" });
export type WorkSession = z.infer<typeof WorkSession>;

export const WorkSessionResponse = z
  .object({ session: WorkSession })
  .meta({ id: "WorkSessionResponse" });
export type WorkSessionResponse = z.infer<typeof WorkSessionResponse>;

export const WorkSessionsResponse = z
  .array(WorkSession)
  .meta({ id: "WorkSessionsResponse" });
export type WorkSessionsResponse = z.infer<typeof WorkSessionsResponse>;

// A claim names the issue and the run that coordinates it. Helpers on the same issue pass
// the same runId and join the existing session instead of registering a second one. A
// parent run can claim several issues, each in its own session.
export const ClaimWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
  })
  .meta({ id: "ClaimWorkSessionInput" });
export type ClaimWorkSessionInput = z.infer<typeof ClaimWorkSessionInput>;

export const RenewWorkSessionInput = z
  .object({ issueId: z.string().trim().min(1).max(200) })
  .meta({ id: "RenewWorkSessionInput" });
export type RenewWorkSessionInput = z.infer<typeof RenewWorkSessionInput>;

export const ReportProgressInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
  })
  .meta({ id: "ReportProgressInput" });
export type ReportProgressInput = z.infer<typeof ReportProgressInput>;

export const StopWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    outcome: WorkSessionOutcome.default("completed"),
  })
  .meta({ id: "StopWorkSessionInput" });
export type StopWorkSessionInput = z.infer<typeof StopWorkSessionInput>;

export const GetWorkSessionInput = z
  .object({ issueId: z.string().trim().min(1).max(200) })
  .meta({ id: "GetWorkSessionInput" });
export type GetWorkSessionInput = z.infer<typeof GetWorkSessionInput>;

// Minimal ready work: the eligible open issues in a project, not a full board. An issue
// is ready while open, not marked Needs input, and without a live (unevaluated-expired)
// active session. The rows are ordinary Issues so REST and MCP use the same shape as every
// other issue listing; only the filtering is minimal.
export const ReadyWorkResponse = z.array(Issue).meta({ id: "ReadyWorkResponse" });
export type ReadyWorkResponse = z.infer<typeof ReadyWorkResponse>;

export const ReadyWorkInput = z
  .object({ projectId: z.string().trim().min(1).max(200) })
  .meta({ id: "ReadyWorkInput" });
export type ReadyWorkInput = z.infer<typeof ReadyWorkInput>;

export const WorkSessionsListInput = z
  .object({ issueId: z.string().trim().min(1).max(200) })
  .meta({ id: "WorkSessionsListInput" });
export type WorkSessionsListInput = z.infer<typeof WorkSessionsListInput>;
