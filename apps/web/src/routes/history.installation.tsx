import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
      <p>
        <Link to="/">Back to your workspaces</Link>
      </p>
      <h1>Installation history</h1>
      {events === null ? (
        <p role="alert">Installation history is available to system administrators only.</p>
      ) : (
        <HistoryList
          events={events}
          emptyMessage="No installation access events have been recorded yet."
        />
      )}
    </main>
  );
}
