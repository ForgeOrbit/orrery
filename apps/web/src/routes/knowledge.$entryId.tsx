import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { KnowledgeEntry } from "@orrery/contract";
import {
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectActivityQuery,
  ResourceLoadError,
  TitleBodyForm,
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

  return (
    <section>
      <h2>Edit knowledge</h2>
      <TitleBodyForm
        idPrefix="edit-knowledge"
        titleLabel="Title"
        bodyLabel="Markdown"
        bodyRows={10}
        submitLabel="Save knowledge"
        fallbackError="Could not save the entry."
        initialTitle={entry.title}
        initialBody={entry.body}
        onSubmit={async ({ title, body }) => {
          const updated = await updateKnowledgeEntry(entry.id, { title, body });
          queryClient.setQueryData(knowledgeEntryQuery(entry.id).queryKey, updated);
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: knowledgeEntriesQuery(entry.projectId).queryKey,
            }),
            queryClient.invalidateQueries({
              queryKey: projectActivityQuery(entry.projectId).queryKey,
            }),
          ]);
        }}
      />
    </section>
  );
}
