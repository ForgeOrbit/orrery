import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { type Issue, type IssueDetail } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link } from "../../lib/Link.tsx";
import { TextField } from "../../lib/fields.tsx";
import { createIssue } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery, readyWorkQuery } from "./queries.ts";
import { issueStatusLabels } from "./issue-status.ts";

// #97: subtasks are ordinary issues in the same project with a one-level parent pointer.
// The project's issue list already carries them, so counts and the child list are derived
// during render — no extra endpoint and no effect.
export function subtasksOf(issues: Issue[], parentId: string): Issue[] {
  return issues.filter((issue) => issue.parentIssueId === parentId);
}

export function completedSubtaskCount(subtasks: Issue[]): number {
  return subtasks.filter((issue) => issue.status === "done" || issue.status === "cancelled").length;
}

export function Subtasks({
  issue,
  issues,
  canContribute,
}: {
  issue: IssueDetail;
  issues: Issue[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const subtasks = subtasksOf(issues, issue.id);
  const completed = completedSubtaskCount(subtasks);
  const parent =
    issue.parentIssueId === null ? undefined : issues.find((i) => i.id === issue.parentIssueId);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await createIssue(issue.projectId, { title, parentIssueId: issue.id });
      setTitle("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuery(issue.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({
          queryKey: projectActivityQuery(issue.projectId).queryKey,
        }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the subtask.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section className="page-section" padding={0} data-subtasks-section>
      <Heading level={2} color="inherit">
        Subtasks
      </Heading>
      <Text
        as="p"
        display="block"
        type="supporting"
        data-subtask-count={subtasks.length}
        data-completed-subtask-count={completed}
      >
        {completed} of {subtasks.length} complete
      </Text>
      {parent !== undefined && (
        <Text as="p" display="block" type="supporting">
          Subtask of{" "}
          <Link to="/issues/$issueId" params={{ issueId: parent.id }}>
            {parent.identifier} {parent.title}
          </Link>
        </Text>
      )}
      {subtasks.length === 0 ? (
        <Text as="p" display="block" type="supporting">
          No subtasks yet.
        </Text>
      ) : (
        <ul>
          {subtasks.map((subtask) => (
            <li key={subtask.id} data-subtask-id={subtask.id} data-subtask-status={subtask.status}>
              <Link to="/issues/$issueId" params={{ issueId: subtask.id }}>
                {subtask.identifier} {subtask.title}
              </Link>{" "}
              · {issueStatusLabels[subtask.status]}
            </li>
          ))}
        </ul>
      )}
      {canContribute && (
        <form onSubmit={(event) => void onCreate(event)}>
          <TextField
            label="Subtask name"
            id="new-subtask-title"
            htmlName="title"
            value={title}
            onChange={setTitle}
            maxLength={200}
            placeholder="What needs to happen?"
            required
          />
          <Button type="submit" label="Create subtask" variant="primary" isDisabled={saving} />
        </form>
      )}
      {error !== undefined && (
        <Text as="p" display="block" type="supporting" role="alert">
          {error}
        </Text>
      )}
    </Section>
  );
}
