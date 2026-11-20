import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AgentKeyValidity,
  ProjectAccessLevel,
  workspaceCapabilities,
  type Agent,
  type AgentKey,
  type InvitationSummary,
  type Workspace,
  type WorkspaceCapability,
  type WorkspaceMember,
} from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery } from "../features/accounts/index.ts";
import {
  agentKeysQuery,
  agentsQuery,
  createAgent,
  issueAgentKey,
  ownerRevokeAgentKey,
  revokeAgentKey,
  workspaceAgentKeysQuery,
} from "../features/agents/index.ts";
import { InvitationList } from "../features/invitations/index.ts";
import { createProject, projectQuery, projectsQuery } from "../features/projects/index.ts";
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
      <p>
        <Link to="/">All workspaces</Link>
      </p>
      <h1>{workspace.name}</h1>
      <p>
        {workspace.kind === "personal"
          ? "Personal workspace"
          : `Shared workspace · ${workspace.isOwner ? "Owner" : "Member"}`}
      </p>
      <Projects
        workspaceId={workspace.id}
        canCreate={workspace.isOwner || workspace.canCreateProjects}
      />
      <Agents workspaceId={workspace.id} isOwner={workspace.isOwner} />
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
    <section>
      <h2>Projects</h2>
      {projects.length === 0 ? (
        <p>{canCreate ? "No projects yet." : "No projects have been shared with you yet."}</p>
      ) : (
        <ul>
          {projects.map((project) => (
            <li key={project.id} data-project-id={project.id}>
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                {project.name}
              </Link>{" "}
              <span data-project-access-level={project.accessLevel}>{project.accessLevel}</span>
            </li>
          ))}
        </ul>
      )}
      {canCreate && <CreateProjectForm workspaceId={workspaceId} />}
    </section>
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
      <label htmlFor="project-name">Project name</label>
      <input
        id="project-name"
        name="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        maxLength={120}
      />
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Create project
      </button>
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
    <section>
      <h2>Members</h2>
      {error !== undefined && <p role="alert">{error}</p>}
      <ul>
        {members.map((member) => (
          <li key={member.humanId} data-member-id={member.humanId}>
            {member.email} <span>{member.isOwner ? "Owner" : "Member"}</span>{" "}
            {workspaceCapabilities.map((capability) => (
              <span
                key={capability}
                data-capability={capability}
                data-enabled={String(member[capability])}
              >
                {member[capability]
                  ? `Can ${capabilityLabels[capability].toLowerCase()}`
                  : `Cannot ${capabilityLabels[capability].toLowerCase()}`}{" "}
              </span>
            ))}
            {changeableCapabilities(workspace, member, ownEmail).map((capability) => (
              <button
                key={capability}
                type="button"
                data-capability-action={capability}
                onClick={() => void onCapability(member.humanId, capability)}
                disabled={updating !== undefined}
              >
                {member[capability] ? "Revoke" : "Grant"} {capabilityLabels[capability]}
              </button>
            ))}{" "}
            {!member.isOwner && workspace.isOwner && (
              <button
                type="button"
                onClick={() => void onAppoint(member.humanId)}
                disabled={updating !== undefined}
              >
                Make owner
              </button>
            )}{" "}
            {mayRemove(workspace, member) && (
              <button
                type="button"
                data-action="remove-member"
                onClick={() => void onRemove(member.humanId)}
                disabled={updating !== undefined}
              >
                Remove member
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
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
    <section>
      <h2>Invite someone to {workspace.name}</h2>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="invite-email">Email</label>
        <input
          id="invite-email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="off"
        />
        {selectable.length > 0 && (
          <fieldset>
            <legend>Project access (optional)</legend>
            {selectable.map((project) => (
              <div key={project.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={project.id in offered}
                    onChange={(event) => toggleProject(project.id, event.target.checked)}
                  />{" "}
                  {project.name}
                </label>{" "}
                <label htmlFor={`invite-level-${project.id}`}>Level</label>
                <select
                  id={`invite-level-${project.id}`}
                  value={offered[project.id] ?? "read"}
                  onChange={(event) =>
                    setLevel(project.id, ProjectAccessLevel.parse(event.target.value))
                  }
                  disabled={!(project.id in offered)}
                >
                  <option value="read">Read</option>
                  <option value="contribute">Contribute</option>
                  <option value="manage">Manage</option>
                </select>
              </div>
            ))}
          </fieldset>
        )}
        {error !== undefined && <p role="alert">{error}</p>}
        {invited !== undefined && <p role="status">Invitation sent to {invited}.</p>}
        <button type="submit" disabled={submitting}>
          Send invitation
        </button>
      </form>
    </section>
  );
}

// Agents and their keys (issue #30). An agent is registered under the signed-in human,
// then a key binds it to this workspace and selected projects. The owner's level is a
// ceiling, capped by that human's current access on every request. A key's secret is
// shown once, at issue time; every list and every owner view is secret-free.

const validityOptions = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days (default)" },
  { value: "never", label: "Never" },
] as const;

function Agents({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const { data: agents } = useSuspenseQuery(agentsQuery);
  const { data: mine } = useSuspenseQuery(agentKeysQuery(workspaceId));
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  // An owner also sees keys issued by other humans in this workspace. The query is
  // disabled for ordinary members, whose view stays their own keys.
  const workspaceKeys = useQuery({ ...workspaceAgentKeysQuery(workspaceId), enabled: isOwner });
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();

  const ownIds = new Set(mine.map((key) => key.id));
  const allKeys = new Map<string, AgentKey>();
  for (const key of mine) allKeys.set(key.id, key);
  for (const key of workspaceKeys.data ?? []) allKeys.set(key.id, key);
  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? "Unknown agent";

  async function revoke(key: AgentKey, owner: boolean) {
    setBusyKey(key.id);
    setError(undefined);
    try {
      if (owner) await ownerRevokeAgentKey(workspaceId, key.id);
      else await revokeAgentKey(key.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the key.");
    } finally {
      setBusyKey(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeysQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceAgentKeysQuery(workspaceId).queryKey }),
      ]);
    }
  }

  return (
    <section>
      <h2>Agents</h2>
      {secret !== undefined && (
        <div role="status" data-agent-secret>
          <p>Copy this key now. It is shown once and cannot be recovered later.</p>
          <code>{secret}</code>{" "}
          <button type="button" onClick={() => setSecret(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
      <h3>Registered agents</h3>
      {agents.length === 0 ? (
        <p>No agents yet. Register one below to issue a key.</p>
      ) : (
        <ul>
          {agents.map((agent) => (
            <li key={agent.id} data-agent-id={agent.id}>
              {agent.name}
            </li>
          ))}
        </ul>
      )}
      <CreateAgentForm />
      {agents.length > 0 && (
        <IssueKeyForm
          agents={agents}
          projects={projects}
          workspaceId={workspaceId}
          onIssued={setSecret}
        />
      )}
      <h3>Keys in this workspace</h3>
      {allKeys.size === 0 ? (
        <p>No keys scoped to this workspace.</p>
      ) : (
        <ul>
          {[...allKeys.values()].map((key) => (
            <li key={key.id} data-agent-key-id={key.id}>
              {agentName(key.agentId)} · {key.validity}
              {key.revokedAt !== null ? " · revoked" : ""} ·{" "}
              {key.projects.map((grant) => grant.projectId).join(", ") || "no projects"}
              {ownIds.has(key.id) ? (
                <button
                  type="button"
                  disabled={busyKey === key.id}
                  onClick={() => void revoke(key, false)}
                >
                  Revoke
                </button>
              ) : (
                isOwner && (
                  <button
                    type="button"
                    disabled={busyKey === key.id}
                    onClick={() => void revoke(key, true)}
                  >
                    Revoke (owner)
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateAgentForm() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await createAgent(name);
      setName("");
      await queryClient.invalidateQueries({ queryKey: agentsQuery.queryKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not register the agent.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor="agent-name">Agent name</label>
      <input
        id="agent-name"
        name="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
        maxLength={120}
      />
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Register agent
      </button>
    </form>
  );
}

function IssueKeyForm({
  agents,
  projects,
  workspaceId,
  onIssued,
}: {
  agents: Agent[];
  projects: readonly { id: string; name: string; accessLevel: ProjectAccessLevel }[];
  workspaceId: string;
  onIssued: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [validity, setValidity] = useState<AgentKeyValidity>("90");
  const [selected, setSelected] = useState<Record<string, ProjectAccessLevel>>({});
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function toggle(projectId: string, checked: boolean) {
    setSelected((current) => {
      const next = { ...current };
      if (checked) next[projectId] = next[projectId] ?? "read";
      else delete next[projectId];
      return next;
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const issued = await issueAgentKey({
        agentId,
        workspaceId,
        validity,
        projects: Object.entries(selected).map(([projectId, level]) => ({ projectId, level })),
      });
      onIssued(issued.secret);
      setSelected({});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeysQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceAgentKeysQuery(workspaceId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not issue the key.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <h3>Issue a key</h3>
      <label htmlFor="key-agent">Agent</label>
      <select id="key-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <label htmlFor="key-validity">Validity</label>
      <select
        id="key-validity"
        value={validity}
        onChange={(event) => setValidity(AgentKeyValidity.parse(event.target.value))}
      >
        {validityOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <fieldset>
        <legend>Project access</legend>
        {projects.map((project) => (
          <div key={project.id}>
            <label>
              <input
                type="checkbox"
                checked={project.id in selected}
                onChange={(event) => toggle(project.id, event.target.checked)}
              />{" "}
              {project.name}
            </label>{" "}
            <select
              aria-label={`Level for ${project.name}`}
              value={selected[project.id] ?? "read"}
              disabled={!(project.id in selected)}
              onChange={(event) =>
                setSelected((current) => ({
                  ...current,
                  [project.id]: ProjectAccessLevel.parse(event.target.value),
                }))
              }
            >
              <option value="read">Read</option>
              <option value="contribute">Contribute</option>
              <option value="manage">Manage</option>
            </select>
          </div>
        ))}
      </fieldset>
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting || agentId === ""}>
        Issue key
      </button>
    </form>
  );
}
