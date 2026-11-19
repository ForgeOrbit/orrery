import type { InvitationSummary } from "@orrery/contract";

// One invitation history list, shared by installation administration and a workspace's
// owner view. It shows the recipient, inviter, target, offered grants, every lifecycle
// timestamp, and email delivery as a fact separate from the lifecycle. Actions are only
// offered when the caller passed handlers: recipients use their emailed link instead.
const statusLabels: Record<InvitationSummary["status"], string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  revoked: "Revoked",
};

const formatTime = (value: string) => new Date(value).toLocaleString();

function deliveryLabel(delivery: InvitationSummary["delivery"]): string {
  if (delivery.status === "sent" && delivery.attemptedAt !== null) {
    return `Email sent ${formatTime(delivery.attemptedAt)}`;
  }
  if (delivery.status === "failed" && delivery.attemptedAt !== null) {
    return `Email failed ${formatTime(delivery.attemptedAt)}`;
  }
  return "No delivery attempt recorded";
}

function grantLabel(invitation: InvitationSummary): string {
  return invitation.grants
    .map((grant) =>
      grant.kind === "installation_account" ? "Installation account" : "Workspace member",
    )
    .join(", ");
}

function targetLabel(invitation: InvitationSummary): string {
  return invitation.target.kind === "installation" ? "This installation" : invitation.target.name;
}

function lifecycleTimes(invitation: InvitationSummary): string[] {
  const times = [
    `Sent ${formatTime(invitation.createdAt)}`,
    `Expires ${formatTime(invitation.expiresAt)}`,
  ];
  if (invitation.acceptedAt !== null) times.push(`Accepted ${formatTime(invitation.acceptedAt)}`);
  if (invitation.declinedAt !== null) times.push(`Declined ${formatTime(invitation.declinedAt)}`);
  if (invitation.expiredAt !== null) times.push(`Expired ${formatTime(invitation.expiredAt)}`);
  if (invitation.revokedAt !== null) times.push(`Revoked ${formatTime(invitation.revokedAt)}`);
  return times;
}

export interface InvitationListProps {
  invitations: InvitationSummary[];
  emptyMessage: string;
  busyId?: string;
  error?: string;
  onResend?: (invitation: InvitationSummary) => Promise<void>;
  onRevoke?: (invitation: InvitationSummary) => Promise<void>;
}

export function InvitationList({
  invitations,
  emptyMessage,
  busyId,
  error,
  onResend,
  onRevoke,
}: InvitationListProps) {
  if (invitations.length === 0) return <p>{emptyMessage}</p>;

  return (
    <section>
      <h3>Invitation history</h3>
      {error !== undefined && <p role="alert">{error}</p>}
      <ul>
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            data-invitation-id={invitation.id}
            data-invitation-status={invitation.status}
            data-delivery-status={invitation.delivery.status ?? "unknown"}
          >
            <p>
              <strong>{invitation.email}</strong> <span>{statusLabels[invitation.status]}</span>
            </p>
            <p>
              Invited by {invitation.invitedBy.email} to {targetLabel(invitation)}. Grants:{" "}
              {grantLabel(invitation)}.
            </p>
            <p>{deliveryLabel(invitation.delivery)}</p>
            <p>{lifecycleTimes(invitation).join(" · ")}</p>
            {(onResend !== undefined || onRevoke !== undefined) && (
              <p>
                {(invitation.status === "pending" || invitation.status === "expired") &&
                  onResend !== undefined && (
                    <button
                      type="button"
                      onClick={() => void onResend(invitation)}
                      disabled={busyId !== undefined}
                    >
                      Resend
                    </button>
                  )}{" "}
                {invitation.status === "pending" && onRevoke !== undefined && (
                  <button
                    type="button"
                    onClick={() => void onRevoke(invitation)}
                    disabled={busyId !== undefined}
                  >
                    Revoke
                  </button>
                )}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
