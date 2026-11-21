import { Text } from "@astryxdesign/core/Text";
import { TextField } from "../../lib/fields.tsx";
import { TextAreaField } from "../../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import type { FormEvent } from "react";
import { useState } from "react";

export interface TitleBodyFormProps {
  idPrefix: string;
  titleLabel: string;
  bodyLabel: string;
  bodyRows: number;
  submitLabel: string;
  fallbackError: string;
  initialTitle?: string;
  initialBody?: string;
  resetOnSuccess?: boolean;
  onSubmit: (values: { title: string; body: string }) => Promise<void>;
}

// Shared title + Markdown form used for creating and editing issues and knowledge entries.
// Edit call sites key the component by updatedAt so a successful save remounts it with the
// server's values without needing an effect.
export function TitleBodyForm({
  idPrefix,
  titleLabel,
  bodyLabel,
  bodyRows,
  submitLabel,
  fallbackError,
  initialTitle = "",
  initialBody = "",
  resetOnSuccess = false,
  onSubmit,
}: TitleBodyFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({ title, body });
      if (resetOnSuccess) {
        setTitle("");
        setBody("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      <TextField
        label={titleLabel}
        id={`${idPrefix}-title`}
        htmlName="title"
        value={title}
        onChange={setTitle}
        required
        maxLength={200}
      />

      <TextAreaField
        label={bodyLabel}
        id={`${idPrefix}-body`}
        htmlName="body"
        value={body}
        onChange={setBody}
        rows={bodyRows}
      />
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button type="submit" isDisabled={submitting} label={submitLabel} variant="primary" />
    </form>
  );
}
