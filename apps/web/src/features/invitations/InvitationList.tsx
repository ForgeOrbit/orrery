import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { Button } from "@astryxdesign/core/Button";
import type { InvitationSummary } from "@orrery/contract";

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
    .map((grant) => {
      if (grant.kind === "installation_account") return "Installation account";
      if (grant.kind === "workspace_membership") return "Workspace member";
      return `${grant.projectName ?? "Project no longer in workspace"} (${grant.level})`;
    })
    .join(", ");
}

function targetLabel(invitation: InvitationSummary): string {
  return invitation.target.kind === "installation" ? "This installation" : invitation.target.name;
}

function lifecycleTimes(invitation: InvitationSummary): string[] {
  const times = [
    `Created ${formatTime(invitation.createdAt)}`,
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
  if (invitations.length === 0)
    return (
      <Text as="p" display="block" type="inherit" color="inherit">
        {emptyMessage}
      </Text>
    );

  return (
    <Section className="page-section" padding={3}>
      <Heading level={3} color="inherit">
        Invitation history
      </Heading>
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <ul>
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            data-invitation-id={invitation.id}
            data-invitation-status={invitation.status}
            data-delivery-status={invitation.delivery.status ?? "unknown"}
          >
            <Text as="p" display="block" type="inherit" color="inherit">
              <strong>{invitation.email}</strong>{" "}
              <Text type="inherit" color="inherit">
                {statusLabels[invitation.status]}
              </Text>
            </Text>
            <Text as="p" display="block" type="inherit" color="inherit">
              Invited by {invitation.invitedBy.email} to {targetLabel(invitation)}. Grants:{" "}
              {grantLabel(invitation)}.
            </Text>
            <Text as="p" display="block" type="inherit" color="inherit">
              {deliveryLabel(invitation.delivery)}
            </Text>
            <Text as="p" display="block" type="inherit" color="inherit">
              {lifecycleTimes(invitation).join(" · ")}
            </Text>
            {(onResend !== undefined || onRevoke !== undefined) && (
              <Text as="p" display="block" type="inherit" color="inherit">
                {(invitation.status === "pending" || invitation.status === "expired") &&
                  onResend !== undefined && (
                    <Button
                      type="button"
                      onClick={() => void onResend(invitation)}
                      isDisabled={busyId !== undefined}
                      label="Resend"
                      variant="secondary"
                    />
                  )}{" "}
                {invitation.status === "pending" && onRevoke !== undefined && (
                  <Button
                    type="button"
                    onClick={() => void onRevoke(invitation)}
                    isDisabled={busyId !== undefined}
                    label="Revoke"
                    variant="destructive"
                  />
                )}
              </Text>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
