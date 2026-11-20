import type { IssueStatus, ResumeDisposition, WorkSessionStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

// Explicit Work Session state machine (verified by docs/formal/WorkSessionAndInbox.tla).
// Terminal states (completed, released, expired) are absorbing: an already-lapsed active
// session is effectively expired and must never be overwritten to 'released' or 'completed'.
export const workSessionMachine = defineStateMachine<WorkSessionStatus>("WorkSession", {
  active: ["active", "completed", "released", "expired"],
  completed: [],
  released: [],
  expired: [],
});

// DB-time projection: an active row whose lease has lapsed is effectively expired.
export function effectiveWorkSessionStatus(
  stored: WorkSessionStatus,
  leaseLive: boolean,
): WorkSessionStatus {
  if (stored === "active" && !leaseLive) return "expired";
  return stored;
}

// Pure projection for resume(): maps the run's latest effective status to its disposition.
export function resumeDispositionFor(effective: WorkSessionStatus | undefined): ResumeDisposition {
  if (effective === undefined) return "none";
  if (effective === "active") return "active";
  if (effective === "expired") return "expired";
  return "ended";
}

export type ReacquireDecision = "reacquire" | "session_required" | "issue_blocked";

// Pure guard for reacquire(): only the run's own expired claim on an open, unpaused issue
// may be reacquired into a fresh active session.
export function decideReacquire(
  effectivePrior: WorkSessionStatus | undefined,
  issueStatus: IssueStatus,
  needsInput: boolean,
): ReacquireDecision {
  if (effectivePrior !== "expired") return "session_required";
  if (issueStatus !== "open" || needsInput) return "issue_blocked";
  return "reacquire";
}
