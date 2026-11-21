import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { type Issue, type IssueDetail, type ProjectLabel } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { attachIssueLabel, detachIssueLabel } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery } from "./queries.ts";
import { LabelPill } from "./LabelPill.tsx";

// An issue's labels are part of its payload; attaching or detaching replaces the issue in
// the detail cache and invalidates the project list so every board card agrees.
export function IssueLabels({
  issue,
  labels,
  canContribute,
}: {
  issue: IssueDetail;
  labels: ProjectLabel[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const available = labels.filter(
    (label) => !issue.labels.some((attached) => attached.id === label.id),
  );

  async function refresh(updated: Issue) {
    queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
      old === undefined ? old : { ...old, ...updated },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
      queryClient.invalidateQueries({
        queryKey: projectActivityQuery(issue.projectId).queryKey,
      }),
    ]);
  }

  async function onAttach() {
    if (selected === "") return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await attachIssueLabel(issue.id, selected);
      setSelected("");
      await refresh(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach the label.");
    } finally {
      setSaving(false);
    }
  }

  async function onDetach(labelId: string) {
    setSaving(true);
    setError(undefined);
    try {
      await refresh(await detachIssueLabel(issue.id, labelId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not detach the label.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Labels
      </Heading>
      {issue.labels.length === 0 ? (
        <Text as="p" display="block" type="supporting">
          No labels attached.
        </Text>
      ) : (
        <ul>
          {issue.labels.map((label) => (
            <li key={label.id} data-issue-label-id={label.id}>
              <LabelPill label={label} />
              {canContribute && (
                <Button
                  type="button"
                  label={`Remove ${label.name}`}
                  variant="ghost"
                  size="sm"
                  isDisabled={saving}
                  onClick={() => void onDetach(label.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canContribute && available.length > 0 && (
        <>
          <Selector
            label="Attach label"
            id="issue-attach-label"
            value={selected}
            onChange={setSelected}
            placeholder="Choose a label…"
            options={available.map((label) => ({ value: label.id, label: label.name }))}
          />
          <Button
            type="button"
            label="Attach label"
            variant="secondary"
            isDisabled={saving || selected === ""}
            onClick={() => void onAttach()}
          />
        </>
      )}
      {error !== undefined && (
        <Text as="p" display="block" type="supporting" role="alert">
          {error}
        </Text>
      )}
    </Section>
  );
}
