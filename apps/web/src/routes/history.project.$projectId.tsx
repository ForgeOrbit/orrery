import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import { HistoryList, projectHistoryQuery } from "../features/history/index.ts";
import { projectQuery, ResourceLoadError } from "../features/projects/index.ts";

// The activity and access history of one granted project. A reader sees activity; a
// project manager additionally sees who changed access. Ungranted projects answer 404.
export const Route = createFileRoute("/history/project/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await context.queryClient.ensureQueryData(projectHistoryQuery(project.id));
  },
  component: ProjectHistoryPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="history" error={error} />,
});

function ProjectHistoryPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: events } = useSuspenseQuery(projectHistoryQuery(projectId));

  return (
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/projects/$projectId" params={{ projectId }}>
          Back to {project.name}
        </Link>
      </Text>
      <Heading level={1} color="inherit">
        Project history
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        {project.name}
      </Text>
      <HistoryList
        events={events}
        emptyMessage="No activity or access changes have been recorded in this project."
      />
    </main>
  );
}
