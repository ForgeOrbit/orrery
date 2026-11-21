import type { QuestionStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

export const questionMachine = defineStateMachine<QuestionStatus>("Question", {
  open: ["answered", "paused", "fallback_used"],
  paused: ["answered"],
  answered: [],
  fallback_used: [],
});

export function effectiveQuestionStatus(
  stored: QuestionStatus,
  deadlinePassed: boolean,
): QuestionStatus {
  if (stored === "open" && deadlinePassed) return "paused";
  return stored;
}

export function questionKeepsNeedsInput(status: QuestionStatus): boolean {
  return status === "open" || status === "paused";
}

export type QuestionAnswerAction = "resolve_answered" | "record_follow_up" | "already_resolved";

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
