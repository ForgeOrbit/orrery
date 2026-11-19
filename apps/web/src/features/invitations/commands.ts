import { SessionResponse } from "@orrery/contract";
import type { InvitationRegistrationRequest } from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

// Mutations for this feature. Each posts JSON through the app's one request helper,
// which parses the response with the contract's schemas and turns a Problem (RFC 9457)
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
