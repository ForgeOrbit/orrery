import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { Button } from "@astryxdesign/core/Button";
import { TextField } from "../lib/fields.tsx";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
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
  staticData: { accessPage: true },
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
      <Heading level={1} color="inherit">
        Workspace invitation
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit" role="alert">
        This invitation is invalid, expired, or already used.
      </Text>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/">Go to your workspaces</Link>
      </Text>
    </main>
  );
}

// The loader sends the failure it actually saw. Only an invitation Problem gets the
// invalid-link copy; a network failure or an installation error gets a different message.
function InvitationLoadError({ error }: { error: unknown }) {
  const invalid = error instanceof ApiProblemError && error.code === "invitation_invalid";
  if (invalid) return <InvalidInvitationLink />;
  const stale = error instanceof ApiProblemError && error.code === "invitation_scope_invalid";
  return (
    <main>
      <Heading level={1} color="inherit">
        Workspace invitation
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit" role="alert">
        {stale
          ? "An offered project is no longer in this workspace. Ask for a new invitation."
          : "Could not load this invitation. Check your connection and try again."}
      </Text>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/">Go to your workspaces</Link>
      </Text>
    </main>
  );
}

function WorkspaceInvitationPage() {
  const { token } = Route.useSearch();
  if (token === "") {
    return (
      <main>
        <Heading level={1} color="inherit">
          Workspace invitation
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          This invitation link is incomplete. Ask for a fresh invitation.
        </Text>
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
        <Heading level={1} color="inherit">
          Join {preview.workspaceName}
        </Heading>
        <InvitationScope preview={preview} />
        <Text as="p" display="block" type="inherit" color="inherit">
          Sign in with {preview.email} to join the workspace, or choose a password below if you are
          new.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/signin" search={{ next: `/workspace-invitation?token=${token}` }}>
            Sign in
          </Link>
        </Text>
        <NewAccountForm token={token} />
        <DeclineInvitation token={token} />
      </main>
    );
  }

  if (session.email !== preview.email) {
    return (
      <main>
        <Heading level={1} color="inherit">
          Join {preview.workspaceName}
        </Heading>
        <InvitationScope preview={preview} />
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          This invitation was sent to {preview.email}, but you are signed in as {session.email}.
          Sign in with the invited account to accept it.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/">Go to your workspaces</Link>
        </Text>
      </main>
    );
  }

  return <AcceptInvitation token={token} preview={preview} />;
}

// The offer, before anything is accepted: the workspace, who invited the person, the
// actual project grants offered, and when it expires. The server rechecks every project
// against the workspace at acceptance.
function InvitationScope({ preview }: { preview: WorkspaceInvitationPreview }) {
  const projects = preview.grants.filter((grant) => grant.kind === "project_access");
  return (
    <Section className="page-section" padding={3}>
      <Text as="p" display="block" type="inherit" color="inherit">
        {preview.invitedByEmail} invited {preview.email} to <strong>{preview.workspaceName}</strong>
        .
      </Text>
      <Text as="p" display="block" type="inherit" color="inherit">
        Offered access: workspace membership.
      </Text>
      {projects.length > 0 && (
        <>
          <Text as="p" display="block" type="inherit" color="inherit">
            Project access:
          </Text>
          <ul>
            {projects.map((grant) => (
              <li key={grant.projectId} data-project-grant-id={grant.projectId}>
                {grant.projectName}: {grant.level}
              </li>
            ))}
          </ul>
        </>
      )}
      <Text as="p" display="block" type="inherit" color="inherit">
        Workspace membership alone does not grant project access.
      </Text>
      <Text as="p" display="block" type="inherit" color="inherit">
        This invitation expires {new Date(preview.expiresAt).toLocaleString()}.
      </Text>
    </Section>
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
      <Text as="p" display="block" type="inherit" color="inherit" role="status">
        You declined this invitation. The link no longer works.{" "}
        <Link to="/">Go to your workspaces</Link>
      </Text>
    );
  }

  return (
    <Text as="p" display="block" type="inherit" color="inherit">
      <Button
        type="button"
        onClick={() => void onDecline()}
        isDisabled={submitting}
        label="Decline invitation"
        variant="secondary"
      />
      {error !== undefined && (
        <Text type="inherit" color="inherit" role="alert">
          {" "}
          {error}
        </Text>
      )}
    </Text>
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
      <Heading level={1} color="inherit">
        Join {preview.workspaceName}
      </Heading>
      <InvitationScope preview={preview} />
      <Text as="p" display="block" type="inherit" color="inherit">
        You are signed in as {preview.email}.
      </Text>
      <Text as="p" display="block" type="inherit" color="inherit">
        Accepting adds this shared workspace to your own workspace list.
      </Text>
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button
        type="button"
        onClick={() => void onAccept()}
        isDisabled={submitting}
        label="Accept invitation"
        variant="primary"
      />
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
      // Registration already returns the verified account. Set it infallibly: a
      // transient session-endpoint failure must not strand a consumed token in the
      // generic error path. Clear first so no pre-registration null cache survives.
      queryClient.clear();
      const session: Session = {
        signedIn: true,
        email: account.email,
        displayName: null,
        emailVerified: account.emailVerified,
      };
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
      <Text as="p" display="block" type="inherit" color="inherit" role="status">
        Your account was created for {createdEmail}. <Link to="/signin">Sign in</Link> with the
        password you chose.
      </Text>
    );
  }

  return (
    <Section className="page-section" padding={3}>
      <Heading level={2} color="inherit">
        New to Orrery?
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        Choose a password to create your account and personal workspace.
      </Text>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Password"
          id="workspace-invitation-password"
          htmlName="password"
          type="password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          autoComplete="new-password"
        />
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        <Button
          type="submit"
          isDisabled={submitting}
          label="Create account and join"
          variant="primary"
        />
      </form>
    </Section>
  );
}
