import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { TextField } from "../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import type { InvitationSummary } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, setupStatusQuery } from "../features/accounts/index.ts";
import {
  installationInvitationsQuery,
  InvitationList,
  inviteInstallation,
  resendInstallationInvitation,
  revokeInstallationInvitation,
} from "../features/invitations/index.ts";
import { readinessQuery } from "../features/system/index.ts";
import { createWorkspace, workspaceQuery, workspacesQuery } from "../features/workspaces/index.ts";

// Home: server readiness, who is signed in, their workspaces, and — on a fresh
// installation — the way in.
export const Route = createFileRoute("/")({
  // The loads start together before the component renders, so there is no request waterfall.
  loader: async ({ context }) => {
    const [, session, setup] = await Promise.all([
      context.queryClient.ensureQueryData(readinessQuery),
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(setupStatusQuery),
    ]);
    if (!session.signedIn) {
      throw redirect({ to: setup.setupComplete ? "/signin" : "/setup" });
    }
    await Promise.all([
      context.queryClient.ensureQueryData(workspacesQuery),
      context.queryClient.ensureQueryData(installationInvitationsQuery),
    ]);
  },
  component: Home,
  errorComponent: () => (
    <Text as="p" display="block" type="inherit" color="inherit">
      Server: unreachable
    </Text>
  ),
});

function Home() {
  const { data: health } = useSuspenseQuery(readinessQuery);
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: setup } = useSuspenseQuery(setupStatusQuery);
  const { data: workspaces } = useSuspenseQuery(workspacesQuery);

  return (
    <main>
      <Heading level={1} color="inherit">
        Orrery
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        Server: {health.status} ({health.version})
      </Text>
      {session.signedIn ? (
        <>
          <Text as="p" display="block" type="inherit" color="inherit">
            Signed in as {session.email}.
          </Text>
          <Section className="page-section" padding={0}>
            <Heading level={2} color="inherit">
              Your workspaces
            </Heading>
            <ul>
              {workspaces.map((workspace) => (
                <li key={workspace.id} data-workspace-id={workspace.id}>
                  <Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }}>
                    {workspace.name}
                  </Link>{" "}
                  <Text type="inherit" color="inherit">
                    {workspace.kind === "personal"
                      ? "Personal"
                      : workspace.isOwner
                        ? "Owner"
                        : "Member"}
                  </Text>
                </li>
              ))}
            </ul>
          </Section>
          <CreateWorkspaceForm />
          <InstallationInvitations />
        </>
      ) : setup.setupComplete ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/signin">Sign in</Link> to continue.
        </Text>
      ) : (
        <Text as="p" display="block" type="inherit" color="inherit">
          New installation? <Link to="/setup">Set up Orrery</Link>.
        </Text>
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
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Create a shared workspace
      </Heading>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Workspace name"
          id="workspace-name"
          htmlName="name"
          value={name}
          onChange={setName}
          required
          maxLength={120}
        />
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        <Button type="submit" isDisabled={submitting} label="Create workspace" variant="primary" />
      </form>
    </Section>
  );
}

// System administrators only. The query returns null for any other account, so the
// section is absent rather than a refused request; the server enforces the same rule.
function InstallationInvitations() {
  const { data: invitations } = useSuspenseQuery(installationInvitationsQuery);
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [inviting, setInviting] = useState(false);

  if (invitations === null) return null;

  const reload = () =>
    queryClient.invalidateQueries({ queryKey: installationInvitationsQuery.queryKey });

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviting(true);
    setError(undefined);
    try {
      await inviteInstallation({ email });
      setEmail("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the invitation.");
    } finally {
      setInviting(false);
      // A failed send still created the pending row with a failed delivery; refresh so
      // the history shows it beside the original error without a manual reload.
      await reload();
    }
  }

  async function run(invitation: InvitationSummary, action: () => Promise<unknown>) {
    setBusyId(invitation.id);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the invitation.");
    } finally {
      setBusyId(undefined);
      // A failed delivery still created the new pending row; reload so it is visible
      // beside its lifecycle status.
      await reload();
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Installation invitations
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/settings/smtp">Configure SMTP</Link>
      </Text>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/history/installation">View installation history</Link>
      </Text>
      <form onSubmit={(event) => void onInvite(event)}>
        <TextField
          label="Email"
          id="installation-invite-email"
          htmlName="email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="off"
        />
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        <Button
          type="submit"
          isDisabled={inviting}
          label="Send installation invitation"
          variant="primary"
        />
      </form>
      <InvitationList
        invitations={invitations}
        emptyMessage="No installation invitations yet."
        {...(busyId === undefined ? {} : { busyId })}
        onResend={(invitation) =>
          run(invitation, () => resendInstallationInvitation(invitation.id))
        }
        onRevoke={(invitation) =>
          run(invitation, () => revokeInstallationInvitation(invitation.id))
        }
      />
    </Section>
  );
}
