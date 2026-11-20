import type { RunEventType, RunStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

// Explicit Run & RunChild state machine (verified by docs/formal/RunLifecycle.tla).
// Runs can end and be reactivated by a resumed conversation (`run_started`).
export const runMachine = defineStateMachine<RunStatus>("Run", {
  active: ["active", "ended"],
  ended: ["active", "ended"],
});

export function nextRunStatus(current: RunStatus, event: RunEventType): RunStatus {
  if (event === "run_ended") return runMachine.assertTransition(current, "ended");
  if (event === "run_started" && current === "ended") {
    return runMachine.assertTransition(current, "active");
  }
  return current;
}

export function nextChildRunStatus(event: RunEventType): RunStatus {
  return event === "child_ended" ? "ended" : "active";
}
