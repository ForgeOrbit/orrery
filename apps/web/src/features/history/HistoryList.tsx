import type { HistoryEvent } from "@orrery/contract";

// One list serves every history view. Events carry their own kind and stable type code, so
// a later producer adds a row here simply by recording a new event; no component change
// is needed. The actor is always the stable identity from the event, never a caller's name.
const labels: Record<string, string> = {
  workspace_created: "created the workspace",
  member_joined: "joined the workspace",
  owner_appointed: "appointed an owner",
  member_removed: "removed a member",
  owner_removed: "removed an owner",
  member_left: "left the workspace",
  owner_left: "left the workspace as an owner",
  create_projects_granted: "granted Create projects",
  create_projects_revoked: "revoked Create projects",
  invite_members_granted: "granted Invite members",
  invite_members_revoked: "revoked Invite members",
  remove_members_granted: "granted Remove members",
  remove_members_revoked: "revoked Remove members",
  manage_member_permissions_granted: "granted Manage member permissions",
  manage_member_permissions_revoked: "revoked Manage member permissions",
  project_transfer_authorized: "authorized a project transfer out",
  project_transfer_received: "received a transferred project",
  project_transferred_out: "transferred a project out",
  project_access_granted: "granted project access",
  project_access_level_changed: "changed project access",
  project_access_revoked: "revoked project access",
  agent_key_created: "created a credential for",
  agent_key_revoked: "revoked a credential for",
  agent_key_rotated: "rotated a credential for",
  project_created: "created the project",
  project_renamed: "renamed the project",
  issue_created: "opened issue",
  issue_edited: "edited issue",
  issue_commented: "commented on issue",
  issue_closed: "closed issue",
  issue_reopened: "reopened issue",
  issue_stop_requested: "asked the agent to stop on issue",
  issue_dependency_added: "added a blocker to issue",
  issue_dependency_removed: "removed a blocker from issue",
  knowledge_created: "created knowledge",
  knowledge_edited: "edited knowledge",
  installation_bootstrap: "bootstrapped the installation",
  installation_invitation_created: "invited",
  installation_invitation_accepted: "accepted an invitation from",
  installation_invitation_declined: "declined an invitation from",
  installation_invitation_expired: "let an invitation expire for",
  installation_invitation_revoked: "revoked an invitation for",
  account_deactivated: "deactivated",
  account_reactivated: "reactivated",
};

const formatTime = (value: string) => new Date(value).toLocaleString();

function describe(event: HistoryEvent): string {
  const label = labels[event.type] ?? event.type.replaceAll("_", " ");
  const level =
    event.level !== null
      ? event.previousLevel === null || event.previousLevel === event.level
        ? ` (${event.level})`
        : ` (${event.previousLevel} to ${event.level})`
      : // A revocation records only the level that was taken away.
        event.previousLevel !== null
        ? ` (was ${event.previousLevel})`
        : "";
  const target = event.subject === null ? "" : ` ${event.subject.displayName}`;
  return `${event.actor.displayName} ${label}${target}${level}`;
}

export function HistoryList({
  events,
  emptyMessage = "No events recorded yet.",
}: {
  events: HistoryEvent[];
  emptyMessage?: string;
}) {
  if (events.length === 0) return <p>{emptyMessage}</p>;
  return (
    <ul>
      {events.map((event) => {
        const description = describe(event);
        return (
          <li
            key={event.id}
            data-event-kind={event.kind}
            data-event-type={event.type}
            data-event-id={event.id}
          >
            <span data-event-description={description}>{description}</span>
            {event.summary !== null && <> “{event.summary}”</>}
            {event.scope.name !== null && <> · {event.scope.name}</>} ·{" "}
            <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
          </li>
        );
      })}
    </ul>
  );
}
