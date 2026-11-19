import { SessionResponse, Problem } from "@orrery/contract";
import type { InvitationRegistrationRequest } from "@orrery/contract";

// Mutations for this feature. Each posts JSON, parses the response with the contract's
// schemas, and turns a Problem (RFC 9457) response into a plain Error carrying its most
// specific human text, so the routes can render the failure without knowing anything
// about the transport.

async function postJson<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = Problem.safeParse(await res.json().catch(() => null));
    if (!problem.success) throw new Error(`Request failed (${res.status}).`);
    const { title, detail, errors } = problem.data;
    throw new Error(errors?.[0]?.detail ?? detail ?? title);
  }
  return parse(await res.json());
}

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
