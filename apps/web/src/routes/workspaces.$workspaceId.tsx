import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import {
  ProjectAccessLevel,
  workspaceCapabilities,
  type InvitationSummary,
  type Workspace,
  type WorkspaceCapability,
  type WorkspaceMember,
} from "@orrery/contract";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

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

function mayRemove(workspace: Workspace, member: WorkspaceMember): boolean {
  if (!workspace.isOwner && !workspace.canRemoveMembers) return false;
  return workspace.isOwner || (!member.isOwner && !member.canManageMemberPermissions);
}

type WorkspaceTab = "projects" | "agents" | "runs" | "members";

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
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  const { data: agents } = useSuspenseQuery(agentsQuery);
  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));
  const [tab, setTab] = useState<WorkspaceTab>("projects");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const canCreate = workspace.isOwner || workspace.canCreateProjects;
  const showMembersTab = mayManageMembers(workspace) || mayInvite(workspace);
  const activeTab: WorkspaceTab = tab === "members" && !showMembersTab ? "projects" : tab;

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          <Link key="workspaces" to="/">
            Workspaces
          </Link>,
        ]}
        title={workspace.name}
        badge={
          workspace.kind === "personal"
            ? "Personal workspace"
            : `Shared workspace · ${workspace.isOwner ? "Owner" : "Member"}`
        }
        actions={
          <>
            {(workspace.isOwner || workspace.canManageMemberPermissions) && (
              <Link to="/history/workspace/$workspaceId" params={{ workspaceId: workspace.id }}>
                Access history
              </Link>
            )}
            {mayInvite(workspace) && (
              <Button
                type="button"
                label="Invite member"
                variant="secondary"
                size="sm"
                onClick={() => setInviteOpen(true)}
              />
            )}
            {canCreate && (
              <Button
                type="button"
                label="New project"
                variant="primary"
                size="sm"
                onClick={() => setCreateProjectOpen(true)}
              />
            )}
          </>
        }
      />

      <TabList
        value={activeTab}
        onChange={(value) => {
          if (
            value === "projects" ||
            value === "agents" ||
            value === "runs" ||
            value === "members"
          ) {
            setTab(value);
          }
        }}
        role="tablist"
        aria-label="Workspace sections"
        size="sm"
        hasDivider
      >
        <Tab
          value="projects"
          label="Projects"
          panelId="panel-projects"
          endContent={<Badge label={projects.length} />}
        />
        <Tab
          value="agents"
          label="Agents"
          panelId="panel-agents"
          endContent={<Badge label={agents.length} />}
        />
        <Tab
          value="runs"
          label="Runs"
          panelId="panel-runs"
          endContent={<Badge label={runs.length} />}
        />
        {showMembersTab && <Tab value="members" label="Members" panelId="panel-members" />}
      </TabList>

      {activeTab === "projects" && (
        <section id="panel-projects" role="tabpanel" className="tab-panel">
          <Projects
            workspaceId={workspace.id}
            canCreate={canCreate}
            onCreateClick={() => setCreateProjectOpen(true)}
          />
        </section>
      )}

      {activeTab === "agents" && (
        <section id="panel-agents" role="tabpanel" className="tab-panel">
          <AgentsSection workspaceId={workspace.id} isOwner={workspace.isOwner} />
        </section>
      )}

      {activeTab === "runs" && (
        <section id="panel-runs" role="tabpanel" className="tab-panel">
          <RunsSection workspaceId={workspace.id} />
        </section>
      )}

      {activeTab === "members" && showMembersTab && (
        <section id="panel-members" role="tabpanel" className="tab-panel">
          {mayManageMembers(workspace) && (
            <WorkspaceMembers workspaceId={workspace.id} workspace={workspace} />
          )}
          {mayInvite(workspace) && <WorkspaceInvitations workspaceId={workspace.id} />}
        </section>
      )}

      <Drawer
        isOpen={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        purpose="form"
        label="New project"
        width="26rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title="New project"
              subtitle={workspace.name}
              onOpenChange={setCreateProjectOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
            <CreateProjectForm
              workspaceId={workspace.id}
              onCreated={() => setCreateProjectOpen(false)}
            />
          </LayoutContent>
        </Layout>
      </Drawer>

      {mayInvite(workspace) && (
        <Drawer
          isOpen={inviteOpen}
          onOpenChange={setInviteOpen}
          purpose="form"
          label={`Invite someone to ${workspace.name}`}
          width="28rem"
        >
          <Layout
            height="auto"
            header={
              <DrawerHeader
                title={`Invite to ${workspace.name}`}
                onOpenChange={setInviteOpen}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <InviteMemberForm workspaceId={workspace.id} workspace={workspace} />
            </LayoutContent>
          </Layout>
        </Drawer>
      )}
    </main>
  );
}

function Projects({
  workspaceId,
  canCreate,
  onCreateClick,
}: {
  workspaceId: string;
  canCreate: boolean;
  onCreateClick: () => void;
}) {
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));

  if (projects.length === 0) {
    return (
      <Stack className="empty-panel">
        <EmptyState
          title="No projects yet"
          description={
            canCreate
              ? "Create a project to organize issues, board columns, and agent work sessions."
              : "No projects have been shared with you yet."
          }
          icon={<Icon icon="viewColumns" size="lg" />}
          headingLevel={2}
          actions={
            canCreate ? (
              <Button label="Create project" variant="primary" onClick={onCreateClick} />
            ) : undefined
          }
        />
      </Stack>
    );
  }

  return (
    <ul className="entity-grid">
      {projects.map((project) => (
        <li key={project.id} data-project-id={project.id} className="entity-card">
          <Stack direction="horizontal" className="entity-card-top">
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="entity-card-title"
            >
              {project.name}
            </Link>
            <span className="issue-key">{project.key}</span>
          </Stack>
          <Stack direction="horizontal" className="entity-card-meta">
            <Text type="supporting" data-project-access-level={project.accessLevel}>
              {project.accessLevel}
            </Text>
            <Stack direction="horizontal" className="page-header-actions">
              <Link to="/board/$projectId" params={{ projectId: project.id }}>
                Board
              </Link>
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                Issues
              </Link>
            </Stack>
          </Stack>
        </li>
      ))}
    </ul>
  );
}

function CreateProjectForm({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: () => void;
}) {
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
      onCreated();
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
        placeholder="e.g. Web Platform"
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
      <ul className="row-list">
        {members.map((member) => (
          <li key={member.humanId} data-member-id={member.humanId} className="row-item">
            <Stack className="page-header-main">
              <Stack direction="horizontal" className="row-item-main">
                <Text type="inherit" color="inherit" className="row-item-title">
                  {member.email}
                </Text>
                <span className="meta-pill">{member.isOwner ? "Owner" : "Member"}</span>
              </Stack>
              <Stack direction="horizontal" className="row-item-meta">
                {workspaceCapabilities.map((capability) => (
                  <Text
                    type="supporting"
                    key={capability}
                    data-capability={capability}
                    data-enabled={String(member[capability])}
                  >
                    {member[capability]
                      ? `Can ${capabilityLabels[capability].toLowerCase()}`
                      : `Cannot ${capabilityLabels[capability].toLowerCase()}`}
                  </Text>
                ))}
              </Stack>
            </Stack>
            <Stack direction="horizontal" className="page-header-actions">
              {changeableCapabilities(workspace, member, ownEmail).map((capability) => (
                <Button
                  key={capability}
                  type="button"
                  size="sm"
                  data-capability-action={capability}
                  onClick={() => void onCapability(member.humanId, capability)}
                  isDisabled={updating !== undefined}
                  label={`${member[capability] ? "Revoke" : "Grant"} ${capabilityLabels[capability]}`}
                  variant="secondary"
                />
              ))}
              {!member.isOwner && workspace.isOwner && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void onAppoint(member.humanId)}
                  isDisabled={updating !== undefined}
                  label="Make owner"
                  variant="secondary"
                />
              )}
              {mayRemove(workspace, member) && (
                <Button
                  type="button"
                  size="sm"
                  data-action="remove-member"
                  onClick={() => void onRemove(member.humanId)}
                  isDisabled={updating !== undefined}
                  label="Remove member"
                  variant="destructive"
                />
              )}
            </Stack>
          </li>
        ))}
      </ul>
    </Section>
  );
}

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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
        queryClient.invalidateQueries({
          queryKey: workspaceInvitationsQuery(workspaceId).queryKey,
        }),
      ]);
    }
  }

  return (
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
        placeholder="teammate@example.com"
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
              />
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
  );
}
