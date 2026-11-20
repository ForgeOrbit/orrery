import { IssuePriority, type Issue, type IssueDetail } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updateIssue } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery } from "./queries.ts";

// New cards are spaced by this much (the server uses the same step), so the midpoint of a
// card and its neighbour is always distinct from both.
const SORT_STEP = 65535;

// A board badge is a plain label: readers always see the current importance, even when
// they cannot change it.
export function PriorityBadge({ priority }: { priority: IssuePriority }) {
  return <span data-issue-priority={priority}>{priority}</span>;
}

// Move one card within its own priority group. Crossing groups by changing sortOrder would
// have no visible effect, so the neighbours are drawn only from cards of the same priority.
function midpointWithinGroup(issues: Issue[], issue: Issue, direction: -1 | 1): number | undefined {
  const group = issues.filter((candidate) => candidate.priority === issue.priority);
  const index = group.findIndex((candidate) => candidate.id === issue.id);
  const neighbour = group[index + direction];
  if (neighbour === undefined) return undefined;
  const beyond = group[index + 2 * direction];
  const beyondOrder = beyond?.sortOrder ?? neighbour.sortOrder + direction * SORT_STEP;
  return (neighbour.sortOrder + beyondOrder) / 2;
}

// The Contribute controls for the board: set importance, or move a card one slot within its
// priority group. Both are single-row PATCHes using the midpoint scheme, so no sibling is
// rewritten; each change refreshes the list and the activity feed from the server.
export function IssuePriorityControls({
  issue,
  issues,
  projectId,
}: {
  issue: Issue;
  issues: Issue[];
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const group = issues.filter((candidate) => candidate.priority === issue.priority);
  const index = group.findIndex((candidate) => candidate.id === issue.id);
  const canMoveUp = index > 0;
  const canMoveDown = index >= 0 && index < group.length - 1;

  async function save(input: { priority?: IssuePriority; sortOrder?: number }) {
    setSaving(true);
    setError(undefined);
    try {
      const updated = await updateIssue(issue.id, input);
      queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
        old === undefined ? old : { ...old, ...updated },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the issue.");
    } finally {
      setSaving(false);
    }
  }

  function move(direction: -1 | 1) {
    const sortOrder = midpointWithinGroup(issues, issue, direction);
    if (sortOrder !== undefined) void save({ sortOrder });
  }

  return (
    <span data-issue-order-controls={issue.id}>
      <label htmlFor={`issue-priority-${issue.id}`}>Priority</label>
      <select
        id={`issue-priority-${issue.id}`}
        data-issue-priority-select={issue.id}
        value={issue.priority}
        disabled={saving}
        onChange={(event) => {
          const next = IssuePriority.safeParse(event.target.value);
          if (next.success) void save({ priority: next.data });
        }}
      >
        {IssuePriority.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>{" "}
      <button type="button" disabled={saving || !canMoveUp} onClick={() => move(-1)}>
        Move up
      </button>{" "}
      <button type="button" disabled={saving || !canMoveDown} onClick={() => move(1)}>
        Move down
      </button>
      {error !== undefined && <span role="alert">{error}</span>}
    </span>
  );
}
