import type { IssueStatus, ResumeDisposition, WorkSessionStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

export const workSessionMachine = defineStateMachine<WorkSessionStatus>("WorkSession", {
  active: ["active", "completed", "released", "expired"],
  completed: [],
  released: [],
  expired: [],
});

export function effectiveWorkSessionStatus(
  stored: WorkSessionStatus,
  leaseLive: boolean,
): WorkSessionStatus {
  if (stored === "active" && !leaseLive) return "expired";
  return stored;
}

export function resumeDispositionFor(effective: WorkSessionStatus | undefined): ResumeDisposition {
  if (effective === undefined) return "none";
  if (effective === "active") return "active";
  if (effective === "expired") return "expired";
  return "ended";
}

export type ReacquireDecision = "reacquire" | "session_required" | "issue_blocked";

export function decideReacquire(
  effectivePrior: WorkSessionStatus | undefined,
  issueStatus: IssueStatus,
  needsInput: boolean,
): ReacquireDecision {
  if (effectivePrior !== "expired") return "session_required";
  if (issueStatus !== "todo" || needsInput) return "issue_blocked";
  return "reacquire";
}
