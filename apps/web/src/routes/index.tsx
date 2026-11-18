import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { readinessQuery } from "../api/health.ts";

// Placeholder home page: shows that the web app, the server and the shared contract are wired up.
export const Route = createFileRoute("/")({
  // The loader starts the fetch before the component renders, so there is no request waterfall.
  loader: ({ context }) => context.queryClient.ensureQueryData(readinessQuery),
  component: Home,
  errorComponent: () => <p>Server: unreachable</p>,
});

function Home() {
  const { data } = useSuspenseQuery(readinessQuery);
  return (
    <main>
      <h1>Orrery</h1>
      <p>
        Server: {data.status} ({data.version})
      </p>
    </main>
  );
}
