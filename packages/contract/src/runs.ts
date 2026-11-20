import { z } from "zod";
import { Timestamp } from "./common.ts";

// Runs and child workers (issue #34, user stories 48-50). A run is one harness
// conversation under one authenticated agent identity. The bearer key identifies the
// *agent*; the harness's native session id distinguishes concurrent conversations and
// survives a resume. Reported metadata (harness version, model) is stored exactly as
// reported; absent metadata stays null and is displayed as `unknown`. No run identity
// is ever derived from an MCP transport session id or a display name.

// The lifecycle events a harness hook or the MCP check-in tool can report. A check-in
// defaults to run_heartbeat: it is a point-in-time observation, not a claim lease.
export const RunEventType = z
  .enum(["run_started", "run_heartbeat", "run_ended", "child_started", "child_ended"])
  .meta({ id: "RunEventType" });
export type RunEventType = z.infer<typeof RunEventType>;

export const RunStatus = z.enum(["active", "ended"]).meta({ id: "RunStatus" });
export type RunStatus = z.infer<typeof RunStatus>;

// The stable correlation key from the harness: `(harness, nativeSessionId)`. Distinct
// across concurrent conversations and stable across resumes. It is never a transport
// session id or an Orrery-generated value.
export const RunKey = z
  .object({
    harness: z.string().trim().min(1).max(120),
    nativeSessionId: z.string().trim().min(1).max(200),
  })
  .meta({ id: "RunKey" });
export type RunKey = z.infer<typeof RunKey>;

// The child attribution carried by a Codex `agent_id`/`agent_type` hook or a Claude
// `Agent` hook. A child may also name a separate run id. Every field is optional: a
// missing one is stored as null and displayed as `unknown`.
export const RunChildRef = z
  .object({
    agentId: z.string().trim().min(1).max(200).nullable().optional(),
    agentType: z.string().trim().min(1).max(200).nullable().optional(),
    runId: z.string().trim().min(1).max(200).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .meta({ id: "RunChildRef" });
export type RunChildRef = z.infer<typeof RunChildRef>;

// The shared input shape. The REST hook adds its envelope (`schema`) and requires a
// runKey; the MCP tool accepts either an explicit runId or a runKey, and defaults the
// event to run_heartbeat.
export const RunReportInput = z
  .object({
    event: RunEventType.default("run_heartbeat"),
    runKey: RunKey.optional(),
    runId: z.string().trim().min(1).max(200).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    harnessVersion: z.string().trim().min(1).max(200).nullable().optional(),
    agentId: z.string().trim().min(1).max(200).nullable().optional(),
    agentType: z.string().trim().min(1).max(200).nullable().optional(),
    child: RunChildRef.optional(),
    checkIn: z
      .object({ sequence: z.number().int().min(0), at: Timestamp.optional() })
      .optional(),
    at: Timestamp.optional(),
  })
  .meta({ id: "RunReportInput" });
export type RunReportInput = z.infer<typeof RunReportInput>;

// The proposed hook body from docs/design/harness-compatibility-proof.md. The bearer
// credential stays in the Authorization header, never in the body.
export const RunHookEvent = RunReportInput.extend({
  schema: z.literal("orrery.run.hook.v1"),
  runKey: RunKey,
}).meta({ id: "RunHookEvent" });
export type RunHookEvent = z.infer<typeof RunHookEvent>;

// What a successful report answers. A null runId means no identity was reported: the
// UI shows `unknown` rather than inventing one. There is deliberately no lease expiry
// here: claims and five-minute leases belong to #36.
export const RunReportResponse = z
  .object({
    runId: z.string().nullable(),
    accepted: z.boolean(),
    observedAt: Timestamp,
    model: z.string().nullable(),
    harness: z.string().nullable(),
  })
  .meta({ id: "RunReportResponse" });
export type RunReportResponse = z.infer<typeof RunReportResponse>;

export const Run = z
  .object({
    id: z.string(),
    agentId: z.string(),
    workspaceId: z.string(),
    harness: z.string().nullable(),
    harnessVersion: z.string().nullable(),
    nativeSessionId: z.string().nullable(),
    model: z.string().nullable(),
    status: RunStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    endedAt: Timestamp.nullable(),
    lastHeartbeatAt: Timestamp.nullable(),
  })
  .meta({ id: "Run" });
export type Run = z.infer<typeof Run>;

// One reported model value in the run's history. `fromModel` is null when the first
// model was reported; a null `toModel` is never written — absence does not erase a
// known model, it simply leaves it unchanged and unknown where never reported.
export const RunModelChange = z
  .object({
    id: z.string(),
    runId: z.string(),
    fromModel: z.string().nullable(),
    toModel: z.string(),
    reportedAt: Timestamp,
    createdAt: Timestamp,
  })
  .meta({ id: "RunModelChange" });
export type RunModelChange = z.infer<typeof RunModelChange>;

// A child worker linked to its parent run. Repeated reports for the same child update
// this record in place; `childRunId` is set when the child reports its own run id.
export const RunChild = z
  .object({
    id: z.string(),
    runId: z.string(),
    agentId: z.string().nullable(),
    agentType: z.string().nullable(),
    childRunId: z.string().nullable(),
    model: z.string().nullable(),
    status: RunStatus,
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .meta({ id: "RunChild" });
export type RunChild = z.infer<typeof RunChild>;

// The workspace view: a run with its model history and child workers, for display.
export const RunDetail = Run.extend({
  modelHistory: z.array(RunModelChange),
  children: z.array(RunChild),
}).meta({ id: "RunDetail" });
export type RunDetail = z.infer<typeof RunDetail>;

export const RunsResponse = z.object({ runs: z.array(RunDetail) }).meta({ id: "RunsResponse" });
export type RunsResponse = z.infer<typeof RunsResponse>;
