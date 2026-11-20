import { RecoveryMessage } from "@orrery/contract";
import type { ConfirmPasswordReset, RequestPasswordReset } from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

// Mutations for password recovery (issue #31). Each posts JSON through the app's one
// request helper, which parses the response with the contract's schemas and turns a
// Problem (RFC 9457) into a plain Error carrying its most specific human text.

// Asks for a reset link. The answer is deliberately the same whether or not the address
// has an account, so the form can show it verbatim without learning anything.
export function requestPasswordReset(input: RequestPasswordReset): Promise<RecoveryMessage> {
  return postJson("/api/auth/password-reset/request", input, (value) =>
    RecoveryMessage.parse(value),
  );
}

// Redeems the emailed token with the chosen password. The link's GET changes nothing;
// only this POST sets a password and signs out the account's prior browser sessions.
export function confirmPasswordReset(input: ConfirmPasswordReset): Promise<RecoveryMessage> {
  return postJson("/api/auth/password-reset/confirm", input, (value) =>
    RecoveryMessage.parse(value),
  );
}
