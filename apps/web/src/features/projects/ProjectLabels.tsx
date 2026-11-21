import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import type { ProjectLabel } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, FormEvent } from "react";
import { useState } from "react";
import { TextField } from "../../lib/fields.tsx";
import { createProjectLabel, deleteProjectLabel, updateProjectLabel } from "./commands.ts";
import { LabelPill } from "./LabelPill.tsx";
import { issuesQuery, projectActivityQuery, projectLabelsQuery } from "./queries.ts";

const PRESET_COLORS = [
  { name: "Crimson", hex: "#d94848" },
  { name: "Tangerine", hex: "#e06c2b" },
  { name: "Amber", hex: "#c88a1e" },
  { name: "Emerald", hex: "#2f9e66" },
  { name: "Teal", hex: "#1f8a8a" },
  { name: "Cobalt", hex: "#3b74d6" },
  { name: "Violet", hex: "#7c52d9" },
  { name: "Slate", hex: "#64748b" },
] as const;

const VALID_HEX = /^#[0-9a-fA-F]{6}$/;

const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

type SwatchStyle = CSSProperties & { "--swatch-color": string };

function ColorSwatches({
  value,
  onSelect,
  groupLabel,
}: {
  value: string;
  onSelect: (hex: string) => void;
  groupLabel: string;
}) {
  return (
    <Stack direction="horizontal" gap={1} wrap="wrap" role="group" aria-label={groupLabel}>
      {PRESET_COLORS.map((preset) => {
        const active = value.toLowerCase() === preset.hex.toLowerCase();
        const style: SwatchStyle = { "--swatch-color": preset.hex };
        return (
          <button
            key={preset.hex}
            type="button"
            className="label-swatch"
            style={style}
            data-active={active ? "true" : undefined}
            aria-label={`${preset.name} (${preset.hex})`}
            aria-pressed={active}
            onClick={() => onSelect(preset.hex)}
          />
        );
      })}
    </Stack>
  );
}

function LabelPreview({ name, color }: { name: string; color: string }) {
  const validHex = VALID_HEX.test(color) ? color : "#64748b";
  const style: CSSProperties & { "--label-color": string } = { "--label-color": validHex };
  return (
    <Stack direction="horizontal" gap={2} vAlign="center">
      <Text type="supporting" color="secondary">
        Preview:
      </Text>
      <Text as="span" type="supporting" className="label-pill" style={style} data-label-preview>
        {name.trim() === "" ? "Label name" : name.trim()}
      </Text>
    </Stack>
  );
}

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
  const [color, setColor] = useState("#3b74d6");
  const [editingId, setEditingId] = useState<string>();
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<ProjectLabel>();
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
      setColor("#3b74d6");
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
      setConfirmDelete(undefined);
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
    <Stack gap={3}>
      <Section className="page-section" padding={3}>
        <Stack gap={3}>
          <Heading level={2} color="inherit">
            Labels
          </Heading>
          {error !== undefined && (
            <Banner status="error" role="alert" title="Label update failed" description={error} />
          )}
          {labels.length === 0 ? (
            <EmptyState
              title="No labels yet"
              description="Create labels to categorize issues on the board and in issue lists."
              isCompact
              headingLevel={3}
            />
          ) : (
            <Table aria-label="Project labels">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Label</TableHeaderCell>
                  <TableHeaderCell>Color</TableHeaderCell>
                  {canContribute && <TableHeaderCell>Actions</TableHeaderCell>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {labels.map((label) => (
                  <TableRow key={label.id} data-project-label-id={label.id}>
                    {editingId === label.id ? (
                      <TableCell colSpan={canContribute ? 3 : 2}>
                        <form onSubmit={(event) => void onUpdate(event, label)}>
                          <Stack gap={2} hAlign="start">
                            <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="end">
                              <TextField
                                label="Label name"
                                id={`label-name-${label.id}`}
                                htmlName="name"
                                value={editName}
                                onChange={setEditName}
                                maxLength={50}
                                width="min(100%, 16rem)"
                                required
                              />
                              <TextField
                                label="Label color"
                                id={`label-color-${label.id}`}
                                htmlName="color"
                                value={editColor}
                                onChange={setEditColor}
                                placeholder="#3b74d6"
                                width="min(100%, 10rem)"
                                required
                              />
                            </Stack>
                            <ColorSwatches
                              value={editColor}
                              onSelect={setEditColor}
                              groupLabel="Edit color swatches"
                            />
                            <LabelPreview name={editName} color={editColor} />
                            <Stack direction="horizontal" gap={1}>
                              <Button
                                type="submit"
                                label="Save label"
                                variant="primary"
                                size="sm"
                                isDisabled={saving}
                                isLoading={saving}
                              />
                              <Button
                                type="button"
                                label="Cancel"
                                variant="ghost"
                                size="sm"
                                isDisabled={saving}
                                onClick={() => setEditingId(undefined)}
                              />
                            </Stack>
                          </Stack>
                        </form>
                      </TableCell>
                    ) : (
                      <>
                        <TableCell>
                          <LabelPill label={label} />
                        </TableCell>
                        <TableCell>
                          <code>{label.color}</code>
                        </TableCell>
                        {canContribute && (
                          <TableCell>
                            <Stack direction="horizontal" gap={1}>
                              <Button
                                type="button"
                                label="Edit label"
                                variant="secondary"
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
                                onClick={() => setConfirmDelete(label)}
                              />
                            </Stack>
                          </TableCell>
                        )}
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Stack>
      </Section>

      {canContribute && (
        <Section className="page-section" padding={3}>
          <Stack gap={3}>
            <Heading level={3} color="inherit">
              Create label
            </Heading>
            <form onSubmit={(event) => void onCreate(event)}>
              <Stack gap={3} hAlign="start">
                <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="end">
                  <TextField
                    label="New label name"
                    id="new-label-name"
                    htmlName="name"
                    value={name}
                    onChange={setName}
                    maxLength={50}
                    placeholder="e.g. Bug, Backend, UI"
                    width="min(100%, 18rem)"
                    required
                  />
                  <TextField
                    label="New label color"
                    id="new-label-color"
                    htmlName="color"
                    value={color}
                    onChange={setColor}
                    placeholder="#3b74d6"
                    width="min(100%, 10rem)"
                    required
                  />
                </Stack>
                <ColorSwatches value={color} onSelect={setColor} groupLabel="Color swatches" />
                <LabelPreview name={name} color={color} />
                <Button
                  type="submit"
                  label="Create label"
                  variant="primary"
                  isDisabled={saving}
                  isLoading={saving}
                />
              </Stack>
            </form>
          </Stack>
        </Section>
      )}

      <AlertDialog
        isOpen={confirmDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(undefined);
        }}
        title="Delete label?"
        description={
          confirmDelete === undefined
            ? "Delete this label?"
            : `Delete "${confirmDelete.name}"? It will be removed from all issues in this project.`
        }
        actionLabel="Delete label"
        actionVariant="destructive"
        isActionLoading={saving}
        onAction={() => {
          if (confirmDelete !== undefined) void onDelete(confirmDelete);
        }}
      />
    </Stack>
  );
}
