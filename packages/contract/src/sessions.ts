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
    // A human stop request (#82) is a signal on the still-active session, not a new status:
    // the holding agent learns of it on its next renew/progress check-in and ends the
    // session itself. The UI renders an active session with stopRequested as "stopping".
    stopRequested: z.boolean(),
    stopRequestedAt: Timestamp.nullable(),
    stopReason: z.string().nullable(),
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

// The agents view needs the owning project to decide who may stop a session, and Work
// Session rows carry only the issue. The workspace-level listing enriches the session
// with that id; no other Work Session response changes shape.
export const ActiveWorkSession = WorkSession.extend({ projectId: z.string() }).meta({
  id: "ActiveWorkSession",
});
export type ActiveWorkSession = z.infer<typeof ActiveWorkSession>;

export const ActiveWorkSessionsResponse = z
  .array(ActiveWorkSession)
  .meta({ id: "ActiveWorkSessionsResponse" });
export type ActiveWorkSessionsResponse = z.infer<typeof ActiveWorkSessionsResponse>;

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

// `sessionId` is an optional fence. When a client that was interrupted sends a delayed
// renew/progress/stop, naming the session it started with makes the call fail rather than
// silently mutating a newer session the same agent has since acquired on the issue.
// Omitting it keeps #36 callers (helpers, older clients) working unchanged.
const SessionFence = z.string().trim().min(1).max(200);

export const RenewWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    sessionId: SessionFence.optional(),
  })
  .meta({ id: "RenewWorkSessionInput" });
export type RenewWorkSessionInput = z.infer<typeof RenewWorkSessionInput>;

export const ReportProgressInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(20_000),
    sessionId: SessionFence.optional(),
  })
  .meta({ id: "ReportProgressInput" });
export type ReportProgressInput = z.infer<typeof ReportProgressInput>;

export const StopWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    outcome: WorkSessionOutcome.default("completed"),
    sessionId: SessionFence.optional(),
  })
  .meta({ id: "StopWorkSessionInput" });
export type StopWorkSessionInput = z.infer<typeof StopWorkSessionInput>;

export const GetWorkSessionInput = z
  .object({ issueId: z.string().trim().min(1).max(200) })
  .meta({ id: "GetWorkSessionInput" });
export type GetWorkSessionInput = z.infer<typeof GetWorkSessionInput>;

// A human with Contribute or Manage on the project asks the holding agent to stop (#82).
// This is a human-only REST operation: no MCP tool and no agent key may request it. The
// reason is optional and is kept verbatim (bounded) as a snapshot in the activity feed.
export const RequestStopWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    reason: z
      .string()
      .trim()
      .max(2000)
      .optional()
      // A blank reason is no reason: normalize it away so a stop request never stores an
      // empty string or writes an empty activity summary.
      .transform((value) => (value === undefined || value === "" ? undefined : value)),
  })
  .meta({ id: "RequestStopWorkSessionInput" });
export type RequestStopWorkSessionInput = z.infer<typeof RequestStopWorkSessionInput>;

// Resuming an interrupted conversation (#40, stories 55 and 56). The run is the identity
// of the harness conversation, so resume names both the run and the issue it was working.
// Reacquire uses the same shape: it only ever re-arms the run's own expired claim and can
// never turn a stale write into a fresh claim for a different run.
export const ResumeWorkSessionInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    runId: z.string().trim().min(1).max(200),
  })
  .meta({ id: "ResumeWorkSessionInput" });
export type ResumeWorkSessionInput = z.infer<typeof ResumeWorkSessionInput>;

export const ReacquireWorkSessionInput = ResumeWorkSessionInput;
export type ReacquireWorkSessionInput = z.infer<typeof ReacquireWorkSessionInput>;

// How the original run's claim stands when it resumes. "active" is a live claim;
// "expired" is the same run's lapsed lease, reported without resurrecting it; "ended" is
// a session the run already completed or released; "none" means the run never claimed.
export const ResumeDisposition = z
  .enum(["active", "expired", "ended", "none"])
  .meta({ id: "ResumeDisposition" });
export type ResumeDisposition = z.infer<typeof ResumeDisposition>;

export const ResumeWorkSessionResult = z
  .object({
    runId: z.string(),
    issueId: z.string(),
    disposition: ResumeDisposition,
    // Present for every disposition but "none". For "expired" it still carries the
    // progress recorded before the interruption: expiry never erases progress.
    session: WorkSession.nullable(),
  })
  .meta({ id: "ResumeWorkSessionResult" });
export type ResumeWorkSessionResult = z.infer<typeof ResumeWorkSessionResult>;

// MCP wraps results in a named object; REST returns the bare result/resource.
export const ResumeWorkSessionResponse = z
  .object({ resume: ResumeWorkSessionResult })
  .meta({ id: "ResumeWorkSessionResponse" });
export type ResumeWorkSessionResponse = z.infer<typeof ResumeWorkSessionResponse>;

// Minimal ready work: the eligible open issues in a project, not a full board. An issue
// is ready while open, not marked Needs input, without a live (unevaluated-expired) active
// session, and with no blocked_by issue whose status is not closed (#86). The rows are
// ordinary Issues so REST and MCP use the same shape as every other issue listing; only
// the filtering is minimal.
export const ReadyWorkResponse = z.array(Issue).meta({ id: "ReadyWorkResponse" });
export type ReadyWorkResponse = z.infer<typeof ReadyWorkResponse>;

// Which part of the ready queue a caller wants (#84). `all` keeps the original minimal
// queue and, for an agent, adds issues assigned to that agent; `assignedToMe` and
// `unassigned` narrow it further. Humans see every ready issue under `all` because they
// cannot hold a claim; agents never see issues assigned to a human or a sibling agent.
export const ReadyWorkFilter = z
  .enum(["all", "assignedToMe", "unassigned"])
  .meta({ id: "ReadyWorkFilter" });
export type ReadyWorkFilter = z.infer<typeof ReadyWorkFilter>;

export const ReadyWorkInput = z
  .object({
    projectId: z.string().trim().min(1).max(200),
    filter: ReadyWorkFilter.optional(),
  })
  .meta({ id: "ReadyWorkInput" });
export type ReadyWorkInput = z.infer<typeof ReadyWorkInput>;

export const WorkSessionsListInput = z
  .object({ issueId: z.string().trim().min(1).max(200) })
  .meta({ id: "WorkSessionsListInput" });
export type WorkSessionsListInput = z.infer<typeof WorkSessionsListInput>;

// Ephemeral session activities (#83, design doc section 1). High-frequency telemetry is
// append-only and tied to a work session, never to issue_comments: an interrupted or
// completed session keeps its whole trail. `detail` stays an extensible JSON object so a
// structured block renderer can plug into `action` entries later (#15) without a migration.
export const SessionActivityKind = z
  .enum(["thought", "action", "status"])
  .meta({ id: "SessionActivityKind" });
export type SessionActivityKind = z.infer<typeof SessionActivityKind>;

// A flat JSON object. z.json() is deliberately avoided: its recursive schema makes the
// OpenAPI generator recurse forever; an unknown-valued record is still fully extensible.
// The bound keeps a single telemetry entry from becoming an unbounded JSONB payload; an
// oversized detail is a 400 validation_failed, not a silently truncated value.
export const SessionActivityDetail = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 64_000, {
    message: "Activity detail must be at most 64000 characters when serialized.",
  })
  .meta({ id: "SessionActivityDetail" });
export type SessionActivityDetail = z.infer<typeof SessionActivityDetail>;

export const SessionActivity = z
  .object({
    id: z.string(),
    workSessionId: z.string(),
    // The run named by the session, not a caller-supplied id: an activity cannot be
    // attributed to a run the holding session never belonged to.
    runId: z.string(),
    kind: SessionActivityKind,
    summary: z.string(),
    detail: SessionActivityDetail.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "SessionActivity" });
export type SessionActivity = z.infer<typeof SessionActivity>;

export const SessionActivitiesResponse = z
  .array(SessionActivity)
  .meta({ id: "SessionActivitiesResponse" });
export type SessionActivitiesResponse = z.infer<typeof SessionActivitiesResponse>;

// Appending needs a live session held by the calling agent. The optional sessionId fence
// has the same meaning as renew/progress/stop: a delayed write from an interrupted session
// is refused even if the agent now holds a newer one on the same issue.
export const LogSessionActivityInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    kind: SessionActivityKind,
    summary: z.string().trim().min(1).max(20_000),
    detail: SessionActivityDetail.optional(),
    sessionId: SessionFence.optional(),
  })
  .meta({ id: "LogSessionActivityInput" });
export type LogSessionActivityInput = z.infer<typeof LogSessionActivityInput>;

export const ListSessionActivitiesInput = z
  .object({
    issueId: z.string().trim().min(1).max(200),
    sessionId: SessionFence,
  })
  .meta({ id: "ListSessionActivitiesInput" });
export type ListSessionActivitiesInput = z.infer<typeof ListSessionActivitiesInput>;

// MCP wraps results in a named object; REST returns the bare resource or list (ADR-0003).
export const LogSessionActivityResponse = z
  .object({ activity: SessionActivity })
  .meta({ id: "LogSessionActivityResponse" });
export type LogSessionActivityResponse = z.infer<typeof LogSessionActivityResponse>;

export const ListSessionActivitiesResponse = z
  .object({ activities: SessionActivitiesResponse })
  .meta({ id: "ListSessionActivitiesResponse" });
export type ListSessionActivitiesResponse = z.infer<typeof ListSessionActivitiesResponse>;
