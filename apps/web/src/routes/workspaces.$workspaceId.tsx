import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
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
      {workspace.kind === "shared" && workspace.isOwner && (
        <>
          <OwnerMembers workspaceId={workspace.id} />
          <InviteMemberForm workspaceId={workspace.id} workspaceName={workspace.name} />
        </>
      )}
    </main>
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
