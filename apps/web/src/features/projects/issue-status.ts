import type { IssueStatus } from "@orrery/contract";

export const issueStatusLabels = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<IssueStatus, string>;
