import { Button } from "@astryxdesign/core/Button";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { InvitationSummary } from "@orrery/contract";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
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
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

// Home: authenticated workspace directory. Unauthenticated visitors go straight to /setup
// (on a fresh installation) or /signin.
export const Route = createFileRoute("/")({
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
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        Server: unreachable
      </Text>
    </main>
  ),
});

function Home() {
  const { data: health } = useSuspenseQuery(readinessQuery);
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: workspaces } = useSuspenseQuery(workspacesQuery);
  const [createOpen, setCreateOpen] = useState(false);

  if (!session.signedIn) return null;

  return (
    <main>
      <PageHeader
        title="Workspaces"
        badge={`${health.status} · ${health.version}`}
        subtitle={`Signed in as ${session.email}.`}
        actions={
          <Button
            type="button"
            label="New workspace"
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          />
        }
      />

      <Section padding={0}>
        <Stack direction="horizontal" className="section-toolbar">
          <Heading level={2} color="inherit">
            Your workspaces
          </Heading>
        </Stack>
        <ul className="entity-grid">
          {workspaces.map((workspace) => (
            <li key={workspace.id} data-workspace-id={workspace.id} className="entity-card">
              <Stack direction="horizontal" className="entity-card-top">
                <Link
                  to="/workspaces/$workspaceId"
                  params={{ workspaceId: workspace.id }}
                  className="entity-card-title"
                >
                  {workspace.name}
                </Link>
                <span className="meta-pill">
                  {workspace.kind === "personal"
                    ? "Personal"
                    : workspace.isOwner
                      ? "Owner"
                      : "Member"}
                </span>
              </Stack>
              <Stack direction="horizontal" className="entity-card-meta">
                <Text type="supporting">
                  {workspace.kind === "personal" ? "Private workspace" : "Shared team workspace"}
                </Text>
                <Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }}>
                  Open
                </Link>
              </Stack>
            </li>
          ))}
        </ul>
      </Section>

      <InstallationInvitations />

      <Drawer
        isOpen={createOpen}
        onOpenChange={setCreateOpen}
        purpose="form"
        label="Create a shared workspace"
        width="26rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title="Create a shared workspace"
              onOpenChange={setCreateOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
            <CreateWorkspaceForm onCreated={() => setCreateOpen(false)} />
          </LayoutContent>
        </Layout>
      </Drawer>
    </main>
  );
}

function CreateWorkspaceForm({ onCreated }: { onCreated: () => void }) {
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
      onCreated();
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
    <form onSubmit={(event) => void onSubmit(event)}>
      <TextField
        label="Workspace name"
        id="workspace-name"
        htmlName="name"
        value={name}
        onChange={setName}
        required
        maxLength={120}
        placeholder="e.g. Core Engineering"
      />
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button type="submit" isDisabled={submitting} label="Create workspace" variant="primary" />
    </form>
  );
}

// System administrators only. The query returns null for any other account, so the
// section is absent rather than a refused request; the server enforces the same rule.
function InstallationInvitations() {
  const { data: invitations } = useSuspenseQuery(installationInvitationsQuery);
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [inviteError, setInviteError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [inviting, setInviting] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  if (invitations === null) return null;

  const reload = () =>
    queryClient.invalidateQueries({ queryKey: installationInvitationsQuery.queryKey });

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviting(true);
    setInviteError(undefined);
    try {
      await inviteInstallation({ email });
      setEmail("");
      setInviteOpen(false);
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "Could not send the invitation.");
    } finally {
      setInviting(false);
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
      await reload();
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Stack direction="horizontal" className="section-toolbar">
        <Heading level={2} color="inherit">
          Installation administration
        </Heading>
        <Stack direction="horizontal" className="page-header-actions">
          <Link to="/settings/smtp">Configure SMTP</Link>
          <Link to="/history/installation">Installation history</Link>
          <Button
            type="button"
            label="Invite person"
            variant="secondary"
            size="sm"
            onClick={() => setInviteOpen(true)}
          />
        </Stack>
      </Stack>
      <InvitationList
        invitations={invitations}
        emptyMessage="No installation invitations yet."
        {...(busyId === undefined ? {} : { busyId })}
        {...(error === undefined ? {} : { error })}
        onResend={(invitation) =>
          run(invitation, () => resendInstallationInvitation(invitation.id))
        }
        onRevoke={(invitation) =>
          run(invitation, () => revokeInstallationInvitation(invitation.id))
        }
      />

      <Drawer
        isOpen={inviteOpen}
        onOpenChange={setInviteOpen}
        purpose="form"
        label="Send installation invitation"
        width="26rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title="Invite someone to Orrery"
              onOpenChange={setInviteOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
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
                placeholder="teammate@example.com"
              />
              {inviteError !== undefined && (
                <Text as="p" display="block" type="inherit" color="inherit" role="alert">
                  {inviteError}
                </Text>
              )}
              <Button
                type="submit"
                isDisabled={inviting}
                label="Send installation invitation"
                variant="primary"
              />
            </form>
          </LayoutContent>
        </Layout>
      </Drawer>
    </Section>
  );
}
