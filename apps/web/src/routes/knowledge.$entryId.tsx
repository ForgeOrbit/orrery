import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import { Markdown } from "../lib/Markdown.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";
import type { Issue, KnowledgeEntry } from "@orrery/contract";
import {
  issuesQuery,
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectActivityQuery,
  projectQuery,
  ResourceLoadError,
  TitleBodyForm,
  updateKnowledgeEntry,
} from "../features/projects/index.ts";

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
  const { data: projectIssues = [] } = useQuery(issuesQuery(entry.projectId));
  const canContribute = project.accessLevel !== "read";

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          <Link key="project" to="/projects/$projectId" params={{ projectId: entry.projectId }}>
            Back to project
          </Link>,
        ]}
        title={entry.title}
        badge="Knowledge"
        subtitle={`Created by ${entry.createdBy.displayName} · last edited by ${entry.updatedBy.displayName}`}
      />
      {entry.body === "" ? (
        <Text as="p" display="block" type="supporting">
          No content yet.
        </Text>
      ) : (
        <Stack data-knowledge-body className="page-section">
          <Markdown issueRefs={projectIssues}>{entry.body}</Markdown>
        </Stack>
      )}
      {canContribute && (
        <EditKnowledgeForm key={entry.updatedAt} entry={entry} issues={projectIssues} />
      )}
    </main>
  );
}

function EditKnowledgeForm({ entry, issues }: { entry: KnowledgeEntry; issues: Issue[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  return (
    <Section className="page-section" padding={3}>
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
        mentionIssues={issues}
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
          toast({ body: "Knowledge document saved." });
        }}
      />
    </Section>
  );
}
