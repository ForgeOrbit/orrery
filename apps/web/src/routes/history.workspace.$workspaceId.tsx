import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import { HistoryList, workspaceHistoryQuery } from "../features/history/index.ts";
import { ResourceLoadError } from "../features/projects/index.ts";
import { workspaceQuery } from "../features/workspaces/index.ts";

// A workspace owner's or delegated manager's view of who changed access in the workspace.
// Both loads are in the route's cache before render. The server decides the scope; a
// non-member answers 404 exactly like a missing workspace.
export const Route = createFileRoute("/history/workspace/$workspaceId")({
  loader: async ({ context, params }) => {
    const workspace = await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    await context.queryClient.ensureQueryData(workspaceHistoryQuery(workspace.id));
  },
  component: WorkspaceHistoryPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="history" error={error} />,
});

function WorkspaceHistoryPage() {
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: events } = useSuspenseQuery(workspaceHistoryQuery(workspaceId));

  return (
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/workspaces/$workspaceId" params={{ workspaceId }}>
          Back to {workspace.name}
        </Link>
      </Text>
      <Heading level={1} color="inherit">
        Workspace access history
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        {workspace.name}
      </Text>
      <HistoryList
        events={events}
        emptyMessage="No access changes have been recorded in this workspace."
      />
    </main>
  );
}
