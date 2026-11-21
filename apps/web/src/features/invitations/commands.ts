import { InvitationSummary, InstallationInvitation, SessionResponse } from "@orrery/contract";
import type {
  DeclineInvitationRequest,
  InvitationRegistrationRequest,
  InvitationSummary as InvitationSummaryResource,
  InviteInstallationRequest,
} from "@orrery/contract";
import { post, postJson, postNoContent } from "../../lib/api.ts";

export function registerThroughInvitation(
  input: InvitationRegistrationRequest,
): Promise<SessionResponse> {
  return postJson("/api/invitations/installation/registration", input, (value) =>
    SessionResponse.parse(value),
  );
}

export function inviteInstallation(
  input: InviteInstallationRequest,
): Promise<InstallationInvitation> {
  return postJson("/api/invitations/installation", input, (value) =>
    InstallationInvitation.parse(value),
  );
}

export function resendInstallationInvitation(
  invitationId: string,
): Promise<InvitationSummaryResource> {
  return post(`/api/invitations/installation/${encodeURIComponent(invitationId)}/resend`, (value) =>
    InvitationSummary.parse(value),
  );
}

export function revokeInstallationInvitation(
  invitationId: string,
): Promise<InvitationSummaryResource> {
  return post(`/api/invitations/installation/${encodeURIComponent(invitationId)}/revoke`, (value) =>
    InvitationSummary.parse(value),
  );
}

export function declineInstallationInvitation(input: DeclineInvitationRequest): Promise<void> {
  return postNoContent("/api/invitations/installation/decline", input);
}
