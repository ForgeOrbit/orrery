import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import type { ProjectLabel } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { TextField } from "../../lib/fields.tsx";
import { createProjectLabel, deleteProjectLabel, updateProjectLabel } from "./commands.ts";
import { issuesQuery, projectActivityQuery, projectLabelsQuery } from "./queries.ts";
import { LabelPill } from "./LabelPill.tsx";

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

// #97 project label management. The server owns uniqueness and permissions; this section
// simply offers the same operations a Contribute human is allowed to perform.
export function ProjectLabels({
  projectId,
  labels,
  canContribute,
}: {
  projectId: string;
  labels: ProjectLabel[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectLabelsQuery(projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: ["issues"] }),
      queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
    ]);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await createProjectLabel(projectId, { name, color });
      setName("");
      setColor("");
      await refresh();
      toast({ body: "Label created." });
    } catch (cause) {
      setError(messageOf(cause, "Could not create the label."));
    } finally {
      setSaving(false);
    }
  }

  async function onUpdate(event: FormEvent<HTMLFormElement>, label: ProjectLabel) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await updateProjectLabel(label.id, { name: editName, color: editColor });
      setEditingId(undefined);
      await refresh();
      toast({ body: "Label updated." });
    } catch (cause) {
      const msg = messageOf(cause, "Could not save the label.");
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(label: ProjectLabel) {
    setSaving(true);
    setError(undefined);
    try {
      await deleteProjectLabel(label.id);
      if (editingId === label.id) setEditingId(undefined);
      await refresh();
      toast({ body: `Deleted label "${label.name}".` });
    } catch (cause) {
      const msg = messageOf(cause, "Could not delete the label.");
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section className="page-section" padding={3}>
      <Heading level={2} color="inherit">
        Labels
      </Heading>
      {labels.length === 0 ? (
        <Text as="p" display="block" type="supporting">
          No labels yet.
        </Text>
      ) : (
        <ul>
          {labels.map((label) => (
            <li key={label.id} data-project-label-id={label.id}>
              {editingId === label.id ? (
                <form onSubmit={(event) => void onUpdate(event, label)}>
                  <TextField
                    label="Label name"
                    id={`label-name-${label.id}`}
                    htmlName="name"
                    value={editName}
                    onChange={setEditName}
                    maxLength={50}
                    required
                  />
                  <TextField
                    label="Label color"
                    id={`label-color-${label.id}`}
                    htmlName="color"
                    value={editColor}
                    onChange={setEditColor}
                    placeholder="Six-digit hex color"
                    required
                  />
                  <Button type="submit" label="Save label" variant="primary" isDisabled={saving} />
                  <Button
                    type="button"
                    label="Cancel"
                    variant="ghost"
                    onClick={() => setEditingId(undefined)}
                  />
                </form>
              ) : (
                <>
                  <LabelPill label={label} />
                  {canContribute && (
                    <>
                      <Button
                        type="button"
                        label="Edit label"
                        variant="ghost"
                        size="sm"
                        isDisabled={saving}
                        onClick={() => {
                          setEditingId(label.id);
                          setEditName(label.name);
                          setEditColor(label.color);
                          setError(undefined);
                        }}
                      />
                      <Button
                        type="button"
                        label="Delete label"
                        variant="destructive"
                        size="sm"
                        isDisabled={saving}
                        onClick={() => void onDelete(label)}
                      />
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && (
        <Text as="p" display="block" type="supporting" role="alert">
          {error}
        </Text>
      )}
      {canContribute && (
        <form onSubmit={(event) => void onCreate(event)}>
          <TextField
            label="New label name"
            id="new-label-name"
            htmlName="name"
            value={name}
            onChange={setName}
            maxLength={50}
            required
          />
          <TextField
            label="New label color"
            id="new-label-color"
            htmlName="color"
            value={color}
            onChange={setColor}
            placeholder="Six-digit hex color"
            required
          />
          <Button type="submit" label="Create label" variant="primary" isDisabled={saving} />
        </form>
      )}
    </Section>
  );
}
