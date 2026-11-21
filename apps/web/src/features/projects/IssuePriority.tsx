import { Badge } from "@astryxdesign/core/Badge";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { ISSUE_SORT_STEP, IssuePriority, type Issue, type IssueDetail } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updateIssue } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery } from "./queries.ts";

const PRIORITY_LABELS: Record<IssuePriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

export function PriorityBadge({ priority }: { priority: IssuePriority }) {
  return <Badge data-issue-priority={priority} label={PRIORITY_LABELS[priority]} />;
}

function MoveUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MoveDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 3.5v9M4.5 9 8 12.5 11.5 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function midpointWithinGroup(
  group: Issue[],
  index: number,
  direction: "up" | "down",
): number | undefined {
  const delta = direction === "up" ? -1 : 1;
  const neighbour = group[index + delta];
  if (neighbour === undefined) return undefined;
  const beyond = group[index + 2 * delta];

  const beyondOrder = beyond?.sortOrder ?? neighbour.sortOrder + delta * ISSUE_SORT_STEP;

  if (beyond !== undefined && neighbour.sortOrder === beyond.sortOrder) {
    return direction === "up" ? neighbour.sortOrder - 1 : neighbour.sortOrder + 1;
  }

  return neighbour.sortOrder + (beyondOrder - neighbour.sortOrder) / 2;
}

export function IssuePriorityControls({
  issue,
  issues,
  projectId,
  compact = false,
}: {
  issue: Issue;
  issues: Issue[];
  projectId: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
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
      if (input.priority !== undefined) {
        toast({ body: `Priority set to ${PRIORITY_LABELS[input.priority]}.` });
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not update the issue.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  function move(direction: "up" | "down") {
    const sortOrder = midpointWithinGroup(group, index, direction);
    if (sortOrder !== undefined) void save({ sortOrder });
  }

  return (
    <div
      className={
        compact ? "issue-order-controls issue-order-controls-compact" : "issue-order-controls"
      }
      data-issue-order-controls={issue.id}
    >
      <Selector
        label="Priority"
        isLabelHidden={compact}
        id={`issue-priority-${issue.id}`}
        data-issue-priority-select={issue.id}
        size="sm"
        variant="secondary"
        value={issue.priority}
        isDisabled={saving}
        onChange={(value) => {
          const next = IssuePriority.safeParse(value);
          if (next.success) void save({ priority: next.data });
        }}
        options={IssuePriority.options.map((option) => ({
          value: option,
          label: PRIORITY_LABELS[option],
        }))}
      />
      <div className="issue-order-arrows">
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          isDisabled={saving || !canMoveUp}
          onClick={() => move("up")}
          label="Move up"
          icon={<MoveUpIcon />}
        />
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          isDisabled={saving || !canMoveDown}
          onClick={() => move("down")}
          label="Move down"
          icon={<MoveDownIcon />}
        />
      </div>
      {error !== undefined && (
        <Text type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
