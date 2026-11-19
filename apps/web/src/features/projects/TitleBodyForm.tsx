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
      <label htmlFor={`${idPrefix}-title`}>{titleLabel}</label>
      <input
        id={`${idPrefix}-title`}
        name="title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        required
        maxLength={200}
      />
      <label htmlFor={`${idPrefix}-body`}>{bodyLabel}</label>
      <textarea
        id={`${idPrefix}-body`}
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={bodyRows}
      />
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitLabel}
      </button>
    </form>
  );
}
