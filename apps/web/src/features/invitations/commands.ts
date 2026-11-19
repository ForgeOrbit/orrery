import { InvitationSummary, InstallationInvitation, SessionResponse } from "@orrery/contract";
import type {
  DeclineInvitationRequest,
  InvitationRegistrationRequest,
  InvitationSummary as InvitationSummaryResource,
  InviteInstallationRequest,
} from "@orrery/contract";
import { post, postJson, postNoContent } from "../../lib/api.ts";

// Mutations for this feature. Each posts through the app's one request helper, which
// parses the response with the contract's schemas and turns a Problem (RFC 9457)
// response into a plain Error carrying its most specific human text.

// Redeems the invitation token with the password the recipient chose. The account is
// bound to the invited email and starts verified; the page signs the person in right
// after, with the credentials they just chose.
export function registerThroughInvitation(
  input: InvitationRegistrationRequest,
): Promise<SessionResponse> {
  return postJson("/api/invitations/installation/registration", input, (value) =>
    SessionResponse.parse(value),
  );
}

// Sends one installation invitation. System administrators only; the server decides.
export function inviteInstallation(
  input: InviteInstallationRequest,
): Promise<InstallationInvitation> {
  return postJson("/api/invitations/installation", input, (value) =>
    InstallationInvitation.parse(value),
  );
}

// Resend rotates the link; the previous link stops working. A delivery failure still
// answers with a Problem, and the invitation's pending row records it separately.
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

// The recipient declines from the emailed link; holding the token is the capability.
export function declineInstallationInvitation(input: DeclineInvitationRequest): Promise<void> {
  return postNoContent("/api/invitations/installation/decline", input);
}
