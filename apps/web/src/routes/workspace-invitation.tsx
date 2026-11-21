import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { WorkspaceInvitationToken, type WorkspaceInvitationPreview } from "@orrery/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, signOut, type Session } from "../features/accounts/index.ts";
import {
  acceptWorkspaceInvitation,
  declineWorkspaceInvitation,
  registerThroughWorkspaceInvitation,
  workspaceInvitationPreviewQuery,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";
import { ApiProblemError } from "../lib/api.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { formatDateTime, formatFullDateTime, relativeCountdown } from "../lib/time.ts";

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
      <Banner
        status="error"
        role="alert"
        title="This invitation is invalid, expired, or already used."
      />
      <Text as="p" display="block" type="supporting">
        <Link to="/">Go to your workspaces</Link>
      </Text>
    </main>
  );
}

function InvitationLoadError({ error }: { error: unknown }) {
  const invalid = error instanceof ApiProblemError && error.code === "invitation_invalid";
  if (invalid) return <InvalidInvitationLink />;
  const stale = error instanceof ApiProblemError && error.code === "invitation_scope_invalid";
  return (
    <main>
      <Heading level={1} color="inherit">
        Workspace invitation
      </Heading>
      <Banner
        status="error"
        role="alert"
        title={
          stale
            ? "An offered project is no longer in this workspace. Ask for a new invitation."
            : "Could not load this invitation. Check your connection and try again."
        }
      />
      <Text as="p" display="block" type="supporting">
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
        <Banner
          status="error"
          role="alert"
          title="This invitation link is incomplete. Ask for a fresh invitation."
        />
      </main>
    );
  }
  if (!WorkspaceInvitationToken.safeParse(token).success) {
    return <InvalidInvitationLink />;
  }
  return <Invitation token={token} />;
}

function Invitation({ token }: { token: string }) {
  const { data: preview } = useSuspenseQuery(workspaceInvitationPreviewQuery(token));
  const { data: session } = useSuspenseQuery(sessionQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const switchAccount = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      queryClient.clear();
      await navigate({
        to: "/signin",
        search: { next: `/workspace-invitation?token=${token}` },
        replace: true,
      });
    },
    onError: (cause) => {
      toast({ body: cause.message, type: "error" });
    },
  });

  if (!session.signedIn) {
    return (
      <main>
        <Stack gap={3}>
          <Heading level={1} color="inherit">
            Join {preview.workspaceName}
          </Heading>
          <InvitationScope preview={preview} />
          <Text as="p" display="block" type="supporting">
            Sign in with {preview.email} to join the workspace, or choose a password below if you
            are new.
          </Text>
          <Text as="p" display="block" type="inherit" color="inherit">
            <Link to="/signin" search={{ next: `/workspace-invitation?token=${token}` }}>
              Sign in
            </Link>
          </Text>
          <NewAccountForm token={token} />
          <DeclineInvitation token={token} />
        </Stack>
      </main>
    );
  }

  if (session.email !== preview.email) {
    return (
      <main>
        <Stack gap={3}>
          <Heading level={1} color="inherit">
            Join {preview.workspaceName}
          </Heading>
          <InvitationScope preview={preview} />
          <Banner
            status="warning"
            role="alert"
            title={`This invitation was sent to ${preview.email}, but you are signed in as ${session.email}. Sign in with the invited account to accept it.`}
          />
          <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center">
            <Button
              type="button"
              variant="primary"
              label="Sign out and switch account"
              isLoading={switchAccount.isPending}
              onClick={() => switchAccount.mutate()}
            />
            <Link to="/">Go to your workspaces</Link>
          </Stack>
        </Stack>
      </main>
    );
  }

  return <AcceptInvitation token={token} preview={preview} />;
}

function InvitationScope({ preview }: { preview: WorkspaceInvitationPreview }) {
  const projects = preview.grants.filter((grant) => grant.kind === "project_access");
  return (
    <Section className="page-section" padding={3}>
      <Stack gap={2}>
        <Text as="p" display="block" type="inherit" color="inherit">
          {preview.invitedByEmail} invited {preview.email} to{" "}
          <strong>{preview.workspaceName}</strong>.
        </Text>
        <Text as="p" display="block" type="supporting">
          Offered access: workspace membership.
        </Text>
        {projects.length > 0 && (
          <Stack gap={1}>
            <Text as="p" display="block" type="supporting" weight="semibold">
              Project access:
            </Text>
            <ul className="row-list">
              {projects.map((grant) => (
                <li
                  key={grant.projectId}
                  data-project-grant-id={grant.projectId}
                  className="row-item"
                >
                  {grant.projectName}: {grant.level}
                </li>
              ))}
            </ul>
          </Stack>
        )}
        <Text as="p" display="block" type="supporting">
          Workspace membership alone does not grant project access.
        </Text>
        <Text as="p" display="block" type="supporting">
          This invitation expires{" "}
          <time dateTime={preview.expiresAt} title={formatFullDateTime(preview.expiresAt)}>
            {formatDateTime(preview.expiresAt)} ({relativeCountdown(preview.expiresAt)})
          </time>
          .
        </Text>
      </Stack>
    </Section>
  );
}

function DeclineInvitation({ token }: { token: string }) {
  const [declined, setDeclined] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onDecline() {
    setSubmitting(true);
    setError(undefined);
    try {
      await declineWorkspaceInvitation({ token });
      setConfirmOpen(false);
      setDeclined(true);
    } catch (cause) {
      setConfirmOpen(false);
      setError(cause instanceof Error ? cause.message : "Could not decline the invitation.");
    } finally {
      setSubmitting(false);
    }
  }

  if (declined) {
    return (
      <Stack gap={2}>
        <Banner
          status="info"
          role="status"
          title="You declined this invitation. The link no longer works."
        />
        <Text as="p" display="block" type="supporting">
          <Link to="/">Go to your workspaces</Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={2} hAlign="start">
      <Button
        type="button"
        onClick={() => setConfirmOpen(true)}
        isDisabled={submitting}
        label="Decline invitation"
        variant="secondary"
      />
      {error !== undefined && <Banner status="error" role="alert" title={error} />}
      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Decline workspace invitation?"
        description="Declining permanently invalidates this invitation link. You will need a new invitation to join later."
        actionLabel="Decline invitation"
        actionVariant="destructive"
        isActionLoading={submitting}
        onAction={() => void onDecline()}
      />
    </Stack>
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
      <Stack gap={3}>
        <Heading level={1} color="inherit">
          Join {preview.workspaceName}
        </Heading>
        <InvitationScope preview={preview} />
        <Text as="p" display="block" type="supporting">
          You are signed in as {preview.email}. Accepting adds this shared workspace to your own
          workspace list.
        </Text>
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Stack direction="horizontal" gap={2} wrap="wrap">
          <Button
            type="button"
            onClick={() => void onAccept()}
            isDisabled={submitting}
            isLoading={submitting}
            label="Accept invitation"
            variant="primary"
          />
          <DeclineInvitation token={token} />
        </Stack>
      </Stack>
    </main>
  );
}

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
      <Stack gap={2}>
        <Banner
          status="success"
          role="status"
          title={`Your account was created for ${createdEmail}.`}
        />
        <Text as="p" display="block" type="supporting">
          <Link to="/signin">Sign in</Link> with the password you chose.
        </Text>
      </Stack>
    );
  }

  return (
    <Section className="page-section" padding={3}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Heading level={2} color="inherit">
            New to Orrery?
          </Heading>
          <Text as="p" display="block" type="supporting">
            Choose a password to create your account and personal workspace.
          </Text>
        </Stack>
        <form onSubmit={(event) => void onSubmit(event)}>
          <Stack gap={3}>
            <TextField
              label="Password"
              description="At least 8 characters."
              id="workspace-invitation-password"
              htmlName="password"
              type="password"
              value={password}
              onChange={setPassword}
              required
              minLength={8}
              autoComplete="new-password"
              width="100%"
            />
            {error !== undefined && <Banner status="error" role="alert" title={error} />}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              width="100%"
              isDisabled={submitting}
              isLoading={submitting}
              label="Create account and join"
            />
          </Stack>
        </form>
      </Stack>
    </Section>
  );
}
