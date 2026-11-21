import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
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
  const toast = useToast();
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
      toast({ body: "Subtask created." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the subtask.");
    } finally {
      setSaving(false);
    }
  }

  const isSubtask = issue.parentIssueId !== null;

  return (
    <Section className="page-section" padding={3} data-subtasks-section>
      {isSubtask && (
        <Heading level={2} color="inherit">
          Subtasks
        </Heading>
      )}
      {isSubtask ? (
        parent !== undefined ? (
          <Text as="p" display="block" type="supporting">
            Subtask of{" "}
            <Link to="/issues/$issueId" params={{ issueId: parent.id }}>
              {parent.identifier} {parent.title}
            </Link>
          </Text>
        ) : (
          <Text as="p" display="block" type="supporting">
            Subtask of another issue.
          </Text>
        )
      ) : (
        <>
          <div className="section-toolbar">
            <Heading level={2} color="inherit">
              Subtasks
            </Heading>
            <span
              className="meta-pill"
              data-subtask-count={subtasks.length}
              data-completed-subtask-count={completed}
            >
              {completed} of {subtasks.length} complete
            </span>
          </div>
          {subtasks.length === 0 ? (
            <Text as="p" display="block" type="supporting">
              No subtasks yet.
            </Text>
          ) : (
            <ul className="row-list">
              {subtasks.map((subtask) => (
                <li
                  key={subtask.id}
                  className="row-item"
                  data-subtask-id={subtask.id}
                  data-subtask-status={subtask.status}
                >
                  <div className="row-item-main">
                    <span className="issue-key">{subtask.identifier}</span>
                    <Link
                      to="/issues/$issueId"
                      params={{ issueId: subtask.id }}
                      className="row-item-title"
                    >
                      {subtask.title}
                    </Link>
                  </div>
                  <span className="meta-pill">{issueStatusLabels[subtask.status]}</span>
                </li>
              ))}
            </ul>
          )}
          {canContribute && (
            <form className="issue-inline-form" onSubmit={(event) => void onCreate(event)}>
              <TextField
                label="Subtask name"
                id="new-subtask-title"
                htmlName="title"
                value={title}
                onChange={setTitle}
                maxLength={200}
                placeholder="Add a subtask…"
                required
              />
              <Button
                type="submit"
                size="sm"
                label="Create subtask"
                variant="secondary"
                isDisabled={saving}
              />
            </form>
          )}
          {error !== undefined && (
            <Text as="p" display="block" type="supporting" role="alert">
              {error}
            </Text>
          )}
        </>
      )}
    </Section>
  );
}
