import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, type Session } from "../features/accounts/index.ts";
import {
  acceptWorkspaceInvitation,
  registerThroughWorkspaceInvitation,
  workspaceInvitationPreviewQuery,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";
import { ApiProblemError } from "../lib/api.ts";

// The page a workspace invitation email links to. Opening it (GET) changes nothing: the
// token is consumed only by the accept POST (existing account) or the registration POST
// (new account). A signed-in account whose address does not match the invitation is
// refused in the page and again by the server.
export const Route = createFileRoute("/workspace-invitation")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  loaderDeps: ({ search: { token } }) => ({ token }),
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(sessionQuery);
    if (deps.token !== "") {
      await context.queryClient.ensureQueryData(workspaceInvitationPreviewQuery(deps.token));
    }
  },
  component: WorkspaceInvitationPage,
  errorComponent: ({ error }) => <InvitationLoadError error={error} />,
});

// The loader sends the failure it actually saw. Only an invitation Problem gets the
// invalid-link copy; a network failure or an installation error gets a different message.
function InvitationLoadError({ error }: { error: unknown }) {
  const invalid = error instanceof ApiProblemError && error.code === "invitation_invalid";
  return (
    <main>
      <h1>Workspace invitation</h1>
      {invalid ? (
        <p role="alert">This invitation is invalid, expired, or already used.</p>
      ) : (
        <p role="alert">Could not load this invitation. Check your connection and try again.</p>
      )}
      <p>
        <Link to="/">Go to your workspaces</Link>
      </p>
    </main>
  );
}

function WorkspaceInvitationPage() {
  const { token } = Route.useSearch();
  if (token === "") {
    return (
      <main>
        <h1>Workspace invitation</h1>
        <p role="alert">This invitation link is incomplete. Ask for a fresh invitation.</p>
      </main>
    );
  }
  return <Invitation token={token} />;
}

function Invitation({ token }: { token: string }) {
  const { data: preview } = useSuspenseQuery(workspaceInvitationPreviewQuery(token));
  const { data: session } = useSuspenseQuery(sessionQuery);

  if (!session.signedIn) {
    return (
      <main>
        <h1>Join {preview.workspaceName}</h1>
        <p>
          This invitation was sent to {preview.email}. Sign in with that account to join the
          workspace.
        </p>
        <p>
          <Link to="/signin" search={{ next: `/workspace-invitation?token=${token}` }}>
            Sign in
          </Link>
        </p>
        <NewAccountForm token={token} />
      </main>
    );
  }

  if (session.email !== preview.email) {
    return (
      <main>
        <h1>Join {preview.workspaceName}</h1>
        <p role="alert">
          This invitation was sent to {preview.email}, but you are signed in as {session.email}.
          Sign in with the invited account to accept it.
        </p>
        <p>
          <Link to="/">Go to your workspaces</Link>
        </p>
      </main>
    );
  }

  return <AcceptInvitation token={token} preview={preview} />;
}

function AcceptInvitation({
  token,
  preview,
}: {
  token: string;
  preview: { workspaceId: string; workspaceName: string; email: string };
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onAccept() {
    setSubmitting(true);
    setError(undefined);
    try {
      const workspace = await acceptWorkspaceInvitation({ token });
      queryClient.setQueryData(workspaceQuery(workspace.id).queryKey, workspace);
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not accept the invitation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Join {preview.workspaceName}</h1>
      <p>You are signed in as {preview.email}.</p>
      <p>Accepting adds this shared workspace to your own workspace list.</p>
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void onAccept()} disabled={submitting}>
        Accept invitation
      </button>
    </main>
  );
}

// A new address chooses a password here: the server creates the account, its personal
// workspace, the verified mark, and the membership in one transaction.
function NewAccountForm({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [createdEmail, setCreatedEmail] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const account = await registerThroughWorkspaceInvitation({ token, password });
      try {
        await signIn({ email: account.email, password });
      } catch {
        setCreatedEmail(account.email);
        return;
      }
      const session: Session = { signedIn: true, email: account.email };
      queryClient.setQueryData(sessionQuery.queryKey, session);
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      await navigate({ to: "/" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registration failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  if (createdEmail !== undefined) {
    return (
      <p role="status">
        Your account was created for {createdEmail}. <Link to="/signin">Sign in</Link> with the
        password you chose.
      </p>
    );
  }

  return (
    <section>
      <h2>New to Orrery?</h2>
      <p>Choose a password to create your account and personal workspace.</p>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="workspace-invitation-password">Password</label>
        <input
          id="workspace-invitation-password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
        />
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          Create account and join
        </button>
      </form>
    </section>
  );
}
