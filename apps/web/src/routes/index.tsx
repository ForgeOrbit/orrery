import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, setupStatusQuery } from "../features/accounts/index.ts";
import { readinessQuery } from "../features/system/index.ts";
import { createWorkspace, workspaceQuery, workspacesQuery } from "../features/workspaces/index.ts";

// Home: server readiness, who is signed in, their workspaces, and — on a fresh
// installation — the way in.
export const Route = createFileRoute("/")({
  // The loads start together before the component renders, so there is no request waterfall.
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(readinessQuery),
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(setupStatusQuery),
      context.queryClient.ensureQueryData(workspacesQuery),
    ]);
  },
  component: Home,
  errorComponent: () => <p>Server: unreachable</p>,
});

function Home() {
  const { data: health } = useSuspenseQuery(readinessQuery);
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: setup } = useSuspenseQuery(setupStatusQuery);
  const { data: workspaces } = useSuspenseQuery(workspacesQuery);

  return (
    <main>
      <h1>Orrery</h1>
      <p>
        Server: {health.status} ({health.version})
      </p>
      {session.signedIn ? (
        <>
          <p>Signed in as {session.email}.</p>
          <section>
            <h2>Your workspaces</h2>
            <ul>
              {workspaces.map((workspace) => (
                <li key={workspace.id} data-workspace-id={workspace.id}>
                  <Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }}>
                    {workspace.name}
                  </Link>{" "}
                  <span>
                    {workspace.kind === "personal"
                      ? "Personal"
                      : workspace.isOwner
                        ? "Owner"
                        : "Member"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <CreateWorkspaceForm />
        </>
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

// A small owner-creating form: the signed-in human names a shared workspace and becomes
// its first owner. The workspace detail page is where invitations start.
function CreateWorkspaceForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const workspace = await createWorkspace({ name });
      await queryClient.ensureQueryData(workspaceQuery(workspace.id));
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      setName("");
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the workspace.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2>Create a shared workspace</h2>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="workspace-name">Workspace name</label>
        <input
          id="workspace-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
        />
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          Create workspace
        </button>
      </form>
    </section>
  );
}
