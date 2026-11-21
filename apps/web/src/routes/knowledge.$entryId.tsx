import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import type { KnowledgeEntry } from "@orrery/contract";
import {
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectActivityQuery,
  projectQuery,
  ResourceLoadError,
  TitleBodyForm,
  updateKnowledgeEntry,
} from "../features/projects/index.ts";

// One basic Markdown knowledge entry. It is stored and shown as written; this is not the
// full vault editor (#6). Editing keeps the creator and records the last editor, and is
// offered only when the project's effective level is Contribute or Manage.
export const Route = createFileRoute("/knowledge/$entryId")({
  loader: async ({ context, params }) => {
    const entry = await context.queryClient.ensureQueryData(knowledgeEntryQuery(params.entryId));
    await context.queryClient.ensureQueryData(projectQuery(entry.projectId));
  },
  component: KnowledgePage,
  errorComponent: ({ error }) => <ResourceLoadError resource="knowledge" error={error} />,
});

function KnowledgePage() {
  const { entryId } = Route.useParams();
  const { data: entry } = useSuspenseQuery(knowledgeEntryQuery(entryId));
  const { data: project } = useSuspenseQuery(projectQuery(entry.projectId));
  const canContribute = project.accessLevel !== "read";

  return (
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/projects/$projectId" params={{ projectId: entry.projectId }}>
          Back to project
        </Link>
      </Text>
      <Heading level={1} color="inherit">
        {entry.title}
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        Knowledge · created by {entry.createdBy.displayName} · last edited by{" "}
        {entry.updatedBy.displayName}
      </Text>
      {entry.body === "" ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          No content yet.
        </Text>
      ) : (
        <Stack data-knowledge-body style={{ whiteSpace: "pre-wrap" }}>
          {entry.body}
        </Stack>
      )}
      {canContribute && <EditKnowledgeForm key={entry.updatedAt} entry={entry} />}
    </main>
  );
}

// Keyed by updatedAt at the call site: a successful save remounts the form with the
// server's values, so no effect is needed to synchronize it.
function EditKnowledgeForm({ entry }: { entry: KnowledgeEntry }) {
  const queryClient = useQueryClient();

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Edit knowledge
      </Heading>
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
    </Section>
  );
}
