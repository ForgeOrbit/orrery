import { Text } from "@astryxdesign/core/Text";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { HistoryList, installationHistoryQuery } from "../features/history/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

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
      <PageHeader
        breadcrumbs={[
          <Link key="home" to="/">
            Back to your workspaces
          </Link>,
        ]}
        title="Installation history"
      />
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
