import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  inviteWorkspaceMember,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";

// One workspace's own view. A personal workspace has no invitations; a shared workspace
// shows its owners and members the invite form, which is how an owner brings someone in.
export const Route = createFileRoute("/workspaces/$workspaceId")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
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
        <InviteMemberForm workspaceId={workspace.id} workspaceName={workspace.name} />
      )}
    </main>
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
