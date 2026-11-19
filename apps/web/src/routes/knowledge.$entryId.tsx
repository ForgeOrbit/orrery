import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { KnowledgeEntry } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectActivityQuery,
  ResourceLoadError,
  updateKnowledgeEntry,
} from "../features/projects/index.ts";

// One basic Markdown knowledge entry. It is stored and shown as written; this is not the
// full vault editor (#6). Editing keeps the creator and records the last editor.
export const Route = createFileRoute("/knowledge/$entryId")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(knowledgeEntryQuery(params.entryId));
  },
  component: KnowledgePage,
  errorComponent: ({ error }) => <ResourceLoadError resource="knowledge" error={error} />,
});

function KnowledgePage() {
  const { entryId } = Route.useParams();
  const { data: entry } = useSuspenseQuery(knowledgeEntryQuery(entryId));

  return (
    <main>
      <p>
        <Link to="/projects/$projectId" params={{ projectId: entry.projectId }}>
          Back to project
        </Link>
      </p>
      <h1>{entry.title}</h1>
      <p>
        Knowledge · created by {entry.createdBy.email} · last edited by {entry.updatedBy.email}
      </p>
      {entry.body === "" ? (
        <p>No content yet.</p>
      ) : (
        <div data-knowledge-body style={{ whiteSpace: "pre-wrap" }}>
          {entry.body}
        </div>
      )}
      <EditKnowledgeForm key={entry.updatedAt} entry={entry} />
    </main>
  );
}

// Keyed by updatedAt at the call site: a successful save remounts the form with the
// server's values, so no effect is needed to synchronize it.
function EditKnowledgeForm({ entry }: { entry: KnowledgeEntry }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const updated = await updateKnowledgeEntry(entry.id, { title, body });
      queryClient.setQueryData(knowledgeEntryQuery(entry.id).queryKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: knowledgeEntriesQuery(entry.projectId).queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(entry.projectId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the entry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2>Edit knowledge</h2>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="edit-knowledge-title">Title</label>
        <input
          id="edit-knowledge-title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
        />
        <label htmlFor="edit-knowledge-body">Markdown</label>
        <textarea
          id="edit-knowledge-body"
          name="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={10}
        />
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          Save knowledge
        </button>
      </form>
    </section>
  );
}
