import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ProjectAccessLevel, type InvitationSummary } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { InvitationList } from "../features/invitations/index.ts";
import { createProject, projectQuery, projectsQuery } from "../features/projects/index.ts";
import {
  appointWorkspaceOwner,
  inviteWorkspaceMember,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  updateWorkspaceMember,
  workspaceInvitationsQuery,
  workspaceMembersQuery,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";

// One workspace's own view. Every workspace lists the projects the caller can access.
// A shared workspace shows its owners the member directory, capability management,
// owner appointment, and invite form; ordinary members see their own role and, when
// granted Create projects, the project form. Those controls are owner-only.
export const Route = createFileRoute("/workspaces/$workspaceId")({
  loader: async ({ context, params }) => {
    const workspace = await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    const loads = [
      context.queryClient.ensureQueryData(projectsQuery(params.workspaceId)),
      ...(workspace.kind === "shared" && workspace.isOwner
        ? [
            context.queryClient.ensureQueryData(workspaceMembersQuery(params.workspaceId)),
            context.queryClient.ensureQueryData(workspaceInvitationsQuery(params.workspaceId)),
          ]
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
      {workspace.kind === "shared" && workspace.isOwner && (
        <>
          <OwnerMembers workspaceId={workspace.id} />
          <InviteMemberForm workspaceId={workspace.id} workspaceName={workspace.name} />
          <OwnerInvitations workspaceId={workspace.id} />
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

// Owner-only directory. The server enforces the same boundary; this only decides what
// the page offers. Appointing and capability changes refresh the member roles and the
// caller's workspace list so the effective state comes from the server.
function OwnerMembers({ workspaceId }: { workspaceId: string }) {
  const { data: members } = useSuspenseQuery(workspaceMembersQuery(workspaceId));
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

  async function onCapability(humanId: string, canCreateProjects: boolean) {
    setUpdating(humanId);
    setError(undefined);
    try {
      await updateWorkspaceMember(workspaceId, humanId, { canCreateProjects });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the capability.");
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
            <span data-can-create-projects={String(member.canCreateProjects)}>
              {member.canCreateProjects ? "Can create projects" : "Cannot create projects"}
            </span>
            {!member.isOwner && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void onCapability(member.humanId, !member.canCreateProjects)}
                  disabled={updating !== undefined}
                >
                  {member.canCreateProjects ? "Revoke Create projects" : "Grant Create projects"}
                </button>{" "}
                <button
                  type="button"
                  onClick={() => void onAppoint(member.humanId)}
                  disabled={updating !== undefined}
                >
                  Make owner
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Owner-only history. Delivery is shown as its own fact, so a failed email never reads
// as a failed invitation; resend and revoke are the lifecycle actions, and each keeps
// the previous row visible.
function OwnerInvitations({ workspaceId }: { workspaceId: string }) {
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
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const queryClient = useQueryClient();
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
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
      <h2>Invite someone to {workspaceName}</h2>
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
        {projects.length > 0 && (
          <fieldset>
            <legend>Project access (optional)</legend>
            {projects.map((project) => (
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
