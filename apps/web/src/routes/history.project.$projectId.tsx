import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
      <p>
        <Link to="/projects/$projectId" params={{ projectId }}>
          Back to {project.name}
        </Link>
      </p>
      <h1>Project history</h1>
      <p>{project.name}</p>
      <HistoryList
        events={events}
        emptyMessage="No activity or access changes have been recorded in this project."
      />
    </main>
  );
}
