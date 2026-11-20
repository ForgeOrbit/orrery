import { useQueryClient } from "@tanstack/react-query";
import type { Assignee, Issue } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { updateIssue } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery } from "./queries.ts";

// #84: the assignee selector. A card's assignee is a human member or a registered agent
// in the project's workspace; both are pull-queue hints, never a launch trigger. The
// candidate list is supplied by the route from the workspace's existing reads, so this
// feature stays free of cross-feature import cycles. The server — not this component —
// validates that the chosen identity is active and registered in the workspace.
export type AssigneeCandidate = { value: string; label: string; assignee: Assignee };

export function AssigneeControl({
  issue,
  candidates,
  canContribute,
}: {
  issue: Issue;
  candidates: readonly AssigneeCandidate[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(currentValue(issue));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const chosen = candidates.find((candidate) => candidate.value === value);
    try {
      await updateIssue(issue.id, { assignee: chosen?.assignee ?? null });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuery(issue.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({
          queryKey: projectActivityQuery(issue.projectId).queryKey,
        }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the assignee.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="assignee-control"
      onSubmit={(event) => void onSubmit(event)}
      style={{ display: "inline" }}
    >
      <label htmlFor={`assignee-${issue.id}`}>Assignee</label>{" "}
      <select
        id={`assignee-${issue.id}`}
        value={value}
        disabled={!canContribute || saving}
        onChange={(event) => setValue(event.target.value)}
      >
        <option value="">Unassigned</option>
        {candidates.map((candidate) => (
          <option key={candidate.value} value={candidate.value}>
            {candidate.label}
          </option>
        ))}
        {/* Keep the current assignee selectable even when it is not in the candidate list,
            for example a session registered by another human on a non-owner's view. */}
        {issue.assignee !== null && !candidates.some((c) => c.value === currentValue(issue)) && (
          <option value={currentValue(issue)}>{currentLabel(issue)}</option>
        )}
      </select>{" "}
      <button type="submit" disabled={!canContribute || saving}>
        Save assignee
      </button>
      {error !== undefined && <span role="alert"> {error}</span>}
    </form>
  );
}

function currentValue(issue: Issue): string {
  if (issue.assignee === null) return "";
  return issue.assignee.agentId !== undefined
    ? `agent:${issue.assignee.agentId}`
    : `human:${issue.assignee.humanId ?? ""}`;
}

function currentLabel(issue: Issue): string {
  if (issue.assignee === null) return "Unassigned";
  return issue.assignee.agentId !== undefined
    ? `Agent · ${issue.assignee.displayName}`
    : `Human · ${issue.assignee.displayName}`;
}
