import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { TextField } from "../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import {
  ProjectAccessLevel,
  workspaceCapabilities,
  type InvitationSummary,
  type Workspace,
  type WorkspaceCapability,
  type WorkspaceMember,
} from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery } from "../features/accounts/index.ts";
import { AgentsSection, agentKeysQuery, agentsQuery } from "../features/agents/index.ts";
import { InvitationList } from "../features/invitations/index.ts";
import { createProject, projectQuery, projectsQuery } from "../features/projects/index.ts";
import { RunsSection, workspaceRunsQuery } from "../features/runs/index.ts";
import { activeSessionsQuery as workspaceActiveSessionsQuery } from "../features/work-sessions/index.ts";
import {
  appointWorkspaceOwner,
  inviteWorkspaceMember,
  removeWorkspaceMember,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  updateWorkspaceMember,
  workspaceInvitationsQuery,
  workspaceMembersQuery,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";

// One workspace's own view. Every workspace lists the projects the caller can access.
// A shared workspace shows its members only to callers with member-management or removal
// authority, and its invite form and invitation history only to owners and delegated
// inviters. Which controls appear is a user-experience decision; the server enforces the
// same boundary for every client (#33). No client state is a capability: the effective
// capabilities come from the Workspace response on every load.

const capabilityLabels: Record<WorkspaceCapability, string> = {
  canCreateProjects: "Create projects",
  canInviteMembers: "Invite members",
  canRemoveMembers: "Remove members",
  canManageMemberPermissions: "Manage member permissions",
};

function mayManageMembers(workspace: Workspace): boolean {
  return (
    workspace.kind === "shared" &&
    (workspace.isOwner || workspace.canManageMemberPermissions || workspace.canRemoveMembers)
  );
}

function mayInvite(workspace: Workspace): boolean {
  return workspace.kind === "shared" && (workspace.isOwner || workspace.canInviteMembers);
}

// Owners can change any capability on a non-owner. A permission manager can change only
// the capabilities they hold, on someone else, and never appoint or remove a permission
// manager. An owner's own authority is implicit, so it has no controls.
function changeableCapabilities(
  workspace: Workspace,
  member: WorkspaceMember,
  ownEmail: string | undefined,
): readonly WorkspaceCapability[] {
  if (member.isOwner || member.email === ownEmail) return [];
  if (workspace.isOwner) return workspaceCapabilities;
  if (!workspace.canManageMemberPermissions) return [];
  return workspaceCapabilities.filter(
    (capability) => capability !== "canManageMemberPermissions" && workspace[capability],
  );
}

// Owners may remove anyone except the last owner (a server-side check). A delegated
// remover cannot remove an owner or a permission manager, including themselves.
function mayRemove(workspace: Workspace, member: WorkspaceMember): boolean {
  if (!workspace.isOwner && !workspace.canRemoveMembers) return false;
  return workspace.isOwner || (!member.isOwner && !member.canManageMemberPermissions);
}

export const Route = createFileRoute("/workspaces/$workspaceId")({
  loader: async ({ context, params }) => {
    const workspace = await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    const loads = [
      context.queryClient.ensureQueryData(projectsQuery(params.workspaceId)),
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(agentsQuery),
      context.queryClient.ensureQueryData(agentKeysQuery(params.workspaceId)),
      context.queryClient.ensureQueryData(workspaceRunsQuery(params.workspaceId)),
      context.queryClient.ensureQueryData(workspaceActiveSessionsQuery(params.workspaceId)),
      ...(mayManageMembers(workspace)
        ? [context.queryClient.ensureQueryData(workspaceMembersQuery(params.workspaceId))]
        : []),
      ...(mayInvite(workspace)
        ? [context.queryClient.ensureQueryData(workspaceInvitationsQuery(params.workspaceId))]
        : []),
    ];
    await Promise.all(loads);
  },
  component: WorkspacePage,
});

function WorkspacePage() {
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));

  return (
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/">All workspaces</Link>
      </Text>
      <Heading level={1} color="inherit">
        {workspace.name}
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        {workspace.kind === "personal"
          ? "Personal workspace"
          : `Shared workspace · ${workspace.isOwner ? "Owner" : "Member"}`}
      </Text>
      {(workspace.isOwner || workspace.canManageMemberPermissions) && (
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/history/workspace/$workspaceId" params={{ workspaceId: workspace.id }}>
            View access history
          </Link>
        </Text>
      )}
      <Projects
        workspaceId={workspace.id}
        canCreate={workspace.isOwner || workspace.canCreateProjects}
      />
      <AgentsSection workspaceId={workspace.id} isOwner={workspace.isOwner} />
      <RunsSection workspaceId={workspace.id} />
      {mayManageMembers(workspace) && (
        <WorkspaceMembers workspaceId={workspace.id} workspace={workspace} />
      )}
      {mayInvite(workspace) && (
        <>
          <InviteMemberForm workspaceId={workspace.id} workspace={workspace} />
          <WorkspaceInvitations workspaceId={workspace.id} />
        </>
      )}
    </main>
  );
}

// The projects the caller can access in this workspace. A shared member sees only their
// granted projects, so an empty list does not mean the workspace has none; the create
// form appears only when the server says the caller holds Create projects.
function Projects({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }) {
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Projects
      </Heading>
      {projects.length === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          {canCreate ? "No projects yet." : "No projects have been shared with you yet."}
        </Text>
      ) : (
        <ul>
          {projects.map((project) => (
            <li key={project.id} data-project-id={project.id}>
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                {project.name}
              </Link>{" "}
              <Text type="inherit" color="inherit" data-project-access-level={project.accessLevel}>
                {project.accessLevel}
              </Text>
            </li>
          ))}
        </ul>
      )}
      {canCreate && <CreateProjectForm workspaceId={workspaceId} />}
    </Section>
  );
}

function CreateProjectForm({ workspaceId }: { workspaceId: string }) {
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
      const project = await createProject(workspaceId, { name });
      queryClient.setQueryData(projectQuery(project.id).queryKey, project);
      await queryClient.invalidateQueries({ queryKey: projectsQuery(workspaceId).queryKey });
      setName("");
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <TextField
        label="Project name"
        id="project-name"
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
      <Button type="submit" isDisabled={submitting} label="Create project" variant="primary" />
    </form>
  );
}

// The member directory, shown only to callers whose authority needs it. Every capability
// is shown as an effective value; controls appear only where the caller can change that
// capability on that target. Appointing is always owner-only. Each action refreshes the
// member roles, the caller's workspace capabilities, and the caller's workspace list.
function WorkspaceMembers({
  workspaceId,
  workspace,
}: {
  workspaceId: string;
  workspace: Workspace;
}) {
  const { data: members } = useSuspenseQuery(workspaceMembersQuery(workspaceId));
  const { data: session } = useSuspenseQuery(sessionQuery);
  const ownEmail = session.signedIn ? session.email : undefined;
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState<string>();

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceMembersQuery(workspaceId).queryKey }),
      queryClient.invalidateQueries({ queryKey: workspaceQuery(workspaceId).queryKey }),
      queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
    ]);
  }

  async function onAppoint(humanId: string) {
    setUpdating(humanId);
    setError(undefined);
    try {
      await appointWorkspaceOwner(workspaceId, humanId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not appoint the owner.");
    } finally {
      setUpdating(undefined);
    }
  }

  async function onCapability(humanId: string, capability: WorkspaceCapability) {
    const member = members.find((candidate) => candidate.humanId === humanId);
    if (member === undefined) return;
    setUpdating(humanId);
    setError(undefined);
    try {
      await updateWorkspaceMember(workspaceId, humanId, { [capability]: !member[capability] });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the capability.");
    } finally {
      setUpdating(undefined);
    }
  }

  async function onRemove(humanId: string) {
    setUpdating(humanId);
    setError(undefined);
    try {
      await removeWorkspaceMember(workspaceId, humanId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the member.");
    } finally {
      setUpdating(undefined);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Members
      </Heading>
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <ul>
        {members.map((member) => (
          <li key={member.humanId} data-member-id={member.humanId}>
            {member.email}{" "}
            <Text type="inherit" color="inherit">
              {member.isOwner ? "Owner" : "Member"}
            </Text>{" "}
            {workspaceCapabilities.map((capability) => (
              <Text
                type="inherit"
                color="inherit"
                key={capability}
                data-capability={capability}
                data-enabled={String(member[capability])}
              >
                {member[capability]
                  ? `Can ${capabilityLabels[capability].toLowerCase()}`
                  : `Cannot ${capabilityLabels[capability].toLowerCase()}`}{" "}
              </Text>
            ))}
            {changeableCapabilities(workspace, member, ownEmail).map((capability) => (
              <Button
                key={capability}
                type="button"
                data-capability-action={capability}
                onClick={() => void onCapability(member.humanId, capability)}
                isDisabled={updating !== undefined}
                label={`${member[capability] ? "Revoke" : "Grant"} ${capabilityLabels[capability]}`}
                variant="secondary"
              />
            ))}{" "}
            {!member.isOwner && workspace.isOwner && (
              <Button
                type="button"
                onClick={() => void onAppoint(member.humanId)}
                isDisabled={updating !== undefined}
                label="Make owner"
                variant="secondary"
              />
            )}{" "}
            {mayRemove(workspace, member) && (
              <Button
                type="button"
                data-action="remove-member"
                onClick={() => void onRemove(member.humanId)}
                isDisabled={updating !== undefined}
                label="Remove member"
                variant="destructive"
              />
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// The invitation history, shown to owners and delegated inviters. Delivery is its own
// fact, so a failed email never reads as a failed invitation; resend and revoke are the
// lifecycle actions, and each keeps the previous row visible.
function WorkspaceInvitations({ workspaceId }: { workspaceId: string }) {
  const { data: invitations } = useSuspenseQuery(workspaceInvitationsQuery(workspaceId));
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

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
      await queryClient.invalidateQueries({
        queryKey: workspaceInvitationsQuery(workspaceId).queryKey,
      });
    }
  }

  return (
    <InvitationList
      invitations={invitations}
      emptyMessage="No invitations yet."
      {...(busyId === undefined ? {} : { busyId })}
      {...(error === undefined ? {} : { error })}
      onResend={(invitation) =>
        run(invitation, () => resendWorkspaceInvitation(workspaceId, invitation.id))
      }
      onRevoke={(invitation) =>
        run(invitation, () => revokeWorkspaceInvitation(workspaceId, invitation.id))
      }
    />
  );
}

function InviteMemberForm({
  workspaceId,
  workspace,
}: {
  workspaceId: string;
  workspace: Workspace;
}) {
  const queryClient = useQueryClient();
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  // A delegate may only offer a project they Manage; owners may offer any workspace
  // project. The server rechecks this on create, resend, and acceptance.
  const selectable = workspace.isOwner
    ? projects
    : projects.filter((project) => project.accessLevel === "manage");
  const [email, setEmail] = useState("");
  const [offered, setOffered] = useState<Record<string, ProjectAccessLevel>>({});
  const [error, setError] = useState<string>();
  const [invited, setInvited] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function toggleProject(projectId: string, checked: boolean) {
    setOffered((current) => {
      const next = { ...current };
      if (checked) next[projectId] = next[projectId] ?? "read";
      else delete next[projectId];
      return next;
    });
  }

  function setLevel(projectId: string, level: ProjectAccessLevel) {
    setOffered((current) => ({ ...current, [projectId]: level }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setInvited(undefined);
    try {
      const invitation = await inviteWorkspaceMember(workspaceId, {
        email,
        projectGrants: Object.entries(offered).map(([projectId, level]) => ({
          projectId,
          level,
        })),
      });
      setInvited(invitation.email);
      setEmail("");
      setOffered({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the invitation.");
    } finally {
      setSubmitting(false);
      // A failed delivery still created the pending row with a failed delivery; refresh
      // so the history shows it beside the original error without a manual reload.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
        queryClient.invalidateQueries({
          queryKey: workspaceInvitationsQuery(workspaceId).queryKey,
        }),
      ]);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Invite someone to {workspace.name}
      </Heading>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Email"
          id="invite-email"
          htmlName="email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="off"
        />
        {selectable.length > 0 && (
          <fieldset>
            <legend>Project access (optional)</legend>
            {selectable.map((project) => (
              <Stack key={project.id}>
                <CheckboxInput
                  label={project.name}
                  value={project.id in offered}
                  onChange={(checked) => toggleProject(project.id, checked)}
                />{" "}
                <Selector
                  label="Level"
                  id={`invite-level-${project.id}`}
                  value={offered[project.id] ?? "read"}
                  onChange={(value) => setLevel(project.id, ProjectAccessLevel.parse(value))}
                  isDisabled={!(project.id in offered)}
                  options={[
                    { value: "read", label: "Read" },
                    { value: "contribute", label: "Contribute" },
                    { value: "manage", label: "Manage" },
                  ]}
                />
              </Stack>
            ))}
          </fieldset>
        )}
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        {invited !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="status">
            Invitation sent to {invited}.
          </Text>
        )}
        <Button type="submit" isDisabled={submitting} label="Send invitation" variant="primary" />
      </form>
    </Section>
  );
}
