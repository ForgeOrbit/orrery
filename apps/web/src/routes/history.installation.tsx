import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import { HistoryList, installationHistoryQuery } from "../features/history/index.ts";

// Installation-level access history, visible only to system administrators. The query
// answers null for any other account, so the page shows a plain explanation instead of a
// refused request; the server enforces the same boundary for direct clients.
export const Route = createFileRoute("/history/installation")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(installationHistoryQuery);
  },
  component: InstallationHistoryPage,
});

function InstallationHistoryPage() {
  const { data: events } = useSuspenseQuery(installationHistoryQuery);

  return (
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/">Back to your workspaces</Link>
      </Text>
      <Heading level={1} color="inherit">
        Installation history
      </Heading>
      {events === null ? (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          Installation history is available to system administrators only.
        </Text>
      ) : (
        <HistoryList
          events={events}
          emptyMessage="No installation access events have been recorded yet."
        />
      )}
    </main>
  );
}
