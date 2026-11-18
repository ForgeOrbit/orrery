import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { sessionQuery, setupStatusQuery } from "../features/accounts/index.ts";
import { readinessQuery } from "../features/system/index.ts";

// Home: server readiness, who is signed in, and — on a fresh installation — the way in.
export const Route = createFileRoute("/")({
  // The loads start together before the component renders, so there is no request waterfall.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(readinessQuery),
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(setupStatusQuery),
    ]);
  },
  component: Home,
  errorComponent: () => <p>Server: unreachable</p>,
});

function Home() {
  const { data: health } = useSuspenseQuery(readinessQuery);
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: setup } = useSuspenseQuery(setupStatusQuery);

  return (
    <main>
      <h1>Orrery</h1>
      <p>
        Server: {health.status} ({health.version})
      </p>
      {session.signedIn ? (
        <p>Signed in as {session.email}.</p>
      ) : setup.setupComplete ? (
        <p>
          <Link to="/signin">Sign in</Link> to continue.
        </p>
      ) : (
        <p>
          New installation? <Link to="/setup">Set up Orrery</Link>.
        </p>
      )}
    </main>
  );
}
