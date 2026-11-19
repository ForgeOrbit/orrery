import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { WorkspaceInvitationToken, type WorkspaceInvitationPreview } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, type Session } from "../features/accounts/index.ts";
import {
  acceptWorkspaceInvitation,
  declineWorkspaceInvitation,
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
    if (!WorkspaceInvitationToken.safeParse(deps.token).success) return;
    await context.queryClient.ensureQueryData(sessionQuery);
    await context.queryClient.ensureQueryData(workspaceInvitationPreviewQuery(deps.token));
  },
  component: WorkspaceInvitationPage,
  errorComponent: ({ error }) => <InvitationLoadError error={error} />,
});

function InvalidInvitationLink() {
  return (
    <main>
      <h1>Workspace invitation</h1>
      <p role="alert">This invitation is invalid, expired, or already used.</p>
      <p>
        <Link to="/">Go to your workspaces</Link>
      </p>
    </main>
  );
}

// The loader sends the failure it actually saw. Only an invitation Problem gets the
// invalid-link copy; a network failure or an installation error gets a different message.
function InvitationLoadError({ error }: { error: unknown }) {
  const invalid = error instanceof ApiProblemError && error.code === "invitation_invalid";
  if (invalid) return <InvalidInvitationLink />;
  return (
    <main>
      <h1>Workspace invitation</h1>
      <p role="alert">Could not load this invitation. Check your connection and try again.</p>
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
  if (!WorkspaceInvitationToken.safeParse(token).success) {
    // Malformed and overlong values never reach the API; they are invalid links, not a
    // server or connection failure.
    return <InvalidInvitationLink />;
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
        <InvitationScope preview={preview} />
        <p>
          Sign in with {preview.email} to join the workspace, or choose a password below if you are
          new.
        </p>
        <p>
          <Link to="/signin" search={{ next: `/workspace-invitation?token=${token}` }}>
            Sign in
          </Link>
        </p>
        <NewAccountForm token={token} />
        <DeclineInvitation token={token} />
      </main>
    );
  }

  if (session.email !== preview.email) {
    return (
      <main>
        <h1>Join {preview.workspaceName}</h1>
        <InvitationScope preview={preview} />
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

// The offer, before anything is accepted: the workspace, who invited the person, the
// access it grants, and when it expires. The server rechecks all of it at acceptance.
function InvitationScope({ preview }: { preview: WorkspaceInvitationPreview }) {
  const offered = preview.grants
    .map((grant) =>
      grant.kind === "installation_account" ? "Installation account" : "Workspace member",
    )
    .join(", ");
  return (
    <section>
      <p>
        {preview.invitedByEmail} invited {preview.email} to <strong>{preview.workspaceName}</strong>
        .
      </p>
      <p>Offered access: {offered}. Workspace membership alone does not grant project access.</p>
      <p>This invitation expires {new Date(preview.expiresAt).toLocaleString()}.</p>
    </section>
  );
}

// Holding the emailed link is the capability to decline. Once declined, the same link
// stops working; a reload shows the ordinary invalid-link answer.
function DeclineInvitation({ token }: { token: string }) {
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onDecline() {
    setSubmitting(true);
    setError(undefined);
    try {
      await declineWorkspaceInvitation({ token });
      setDeclined(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not decline the invitation.");
    } finally {
      setSubmitting(false);
    }
  }

  if (declined) {
    return (
      <p role="status">
        You declined this invitation. The link no longer works.{" "}
        <Link to="/">Go to your workspaces</Link>
      </p>
    );
  }

  return (
    <p>
      <button type="button" onClick={() => void onDecline()} disabled={submitting}>
        Decline invitation
      </button>
      {error !== undefined && <span role="alert"> {error}</span>}
    </p>
  );
}

function AcceptInvitation({
  token,
  preview,
}: {
  token: string;
  preview: WorkspaceInvitationPreview;
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
      <InvitationScope preview={preview} />
      <p>You are signed in as {preview.email}.</p>
      <p>Accepting adds this shared workspace to your own workspace list.</p>
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void onAccept()} disabled={submitting}>
        Accept invitation
      </button>
      <DeclineInvitation token={token} />
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
