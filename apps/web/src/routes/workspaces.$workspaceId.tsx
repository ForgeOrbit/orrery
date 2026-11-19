import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { createProject, projectQuery, projectsQuery } from "../features/projects/index.ts";
import {
  appointWorkspaceOwner,
  inviteWorkspaceMember,
  workspaceMembersQuery,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";

// One workspace's own view. A personal workspace has no invitations. A shared workspace
// shows its owners the member directory, owner appointment, and invite form; ordinary
// members see only their own role, because those controls are owner-only.
export const Route = createFileRoute("/workspaces/$workspaceId")({
  loader: async ({ context, params }) => {
    const workspace = await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    await context.queryClient.ensureQueryData(projectsQuery(params.workspaceId));
    if (workspace.kind === "shared" && workspace.isOwner) {
      await context.queryClient.ensureQueryData(workspaceMembersQuery(params.workspaceId));
    }
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
      <Projects workspaceId={workspace.id} canCreate={workspace.isOwner} />
      {workspace.kind === "shared" && workspace.isOwner && (
        <>
          <OwnerMembers workspaceId={workspace.id} />
          <InviteMemberForm workspaceId={workspace.id} workspaceName={workspace.name} />
        </>
      )}
    </main>
  );
}

// The workspace's projects. A personal workspace's owner and a shared workspace's owner
// can create one; an ordinary shared member sees no projects until #27 grants access, and
// the server enforces the same boundary.
function Projects({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }) {
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  return (
    <section>
      <h2>Projects</h2>
      {projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul>
          {projects.map((project) => (
            <li key={project.id} data-project-id={project.id}>
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                {project.name}
              </Link>
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
// the page offers. Appointing refreshes the member roles and the caller's workspace list.
function OwnerMembers({ workspaceId }: { workspaceId: string }) {
  const { data: members } = useSuspenseQuery(workspaceMembersQuery(workspaceId));
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [appointing, setAppointing] = useState<string>();

  async function onAppoint(humanId: string) {
    setAppointing(humanId);
    setError(undefined);
    try {
      await appointWorkspaceOwner(workspaceId, humanId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceMembersQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not appoint the owner.");
    } finally {
      setAppointing(undefined);
    }
  }

  return (
    <section>
      <h2>Members</h2>
      {error !== undefined && <p role="alert">{error}</p>}
      <ul>
        {members.map((member) => (
          <li key={member.humanId} data-member-id={member.humanId}>
            {member.email} <span>{member.isOwner ? "Owner" : "Member"}</span>
            {!member.isOwner && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void onAppoint(member.humanId)}
                  disabled={appointing !== undefined}
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

function InviteMemberForm({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [invited, setInvited] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setInvited(undefined);
    try {
      const invitation = await inviteWorkspaceMember(workspaceId, { email });
      setInvited(invitation.email);
      setEmail("");
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the invitation.");
    } finally {
      setSubmitting(false);
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
        {error !== undefined && <p role="alert">{error}</p>}
        {invited !== undefined && <p role="status">Invitation sent to {invited}.</p>}
        <button type="submit" disabled={submitting}>
          Send invitation
        </button>
      </form>
    </section>
  );
}
