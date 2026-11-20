import type { QuestionStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

// Explicit Inbox Question state machine (verified by docs/formal/WorkSessionAndInbox.tla).
// `open` resolves once: to `answered` before the 1h DB-time deadline, or to `paused` /
// `fallback_used` at/after it. A `paused` question can still be answered by a human to
// unblock the issue (`issues.needsInput -> false`). `answered` and `fallback_used` are
// terminal; a late answer on `fallback_used` records a follow-up without changing status.
export const questionMachine = defineStateMachine<QuestionStatus>("Question", {
  open: ["answered", "paused", "fallback_used"],
  paused: ["answered"],
  answered: [],
  fallback_used: [],
});

// DB-time projection: an open question at/past its 1h deadline reads as paused.
export function effectiveQuestionStatus(
  stored: QuestionStatus,
  deadlinePassed: boolean,
): QuestionStatus {
  if (stored === "open" && deadlinePassed) return "paused";
  return stored;
}

// Synchronization invariant with issues.needs_input: TRUE iff status is open or paused.
export function questionKeepsNeedsInput(status: QuestionStatus): boolean {
  return status === "open" || status === "paused";
}

export type QuestionAnswerAction = "resolve_answered" | "record_follow_up" | "already_resolved";

// Pure decision for a human answer attempt against the current question status.
export function decideQuestionAnswer(
  status: QuestionStatus,
  hasFollowUp: boolean,
): QuestionAnswerAction {
  if (status === "answered") return "already_resolved";
  if (status === "fallback_used") {
    return hasFollowUp ? "already_resolved" : "record_follow_up";
  }
  return "resolve_answered";
}
