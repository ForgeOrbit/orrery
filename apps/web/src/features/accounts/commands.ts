import { LoginResponse, RecoveryMessage, SetupAdminResponse } from "@orrery/contract";
import type {
  ConfirmPasswordReset,
  LoginRequest,
  RequestPasswordReset,
  SetupAdminRequest,
} from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

// Mutations for this feature. Each posts JSON through the app's one request helper,
// which parses the response with the contract's schemas and turns a Problem (RFC 9457)
// response into a plain Error carrying its most specific human text.

// Creates the first system administrator and closes setup. Succeeds exactly once.
export function createFirstAdministrator(input: SetupAdminRequest): Promise<SetupAdminResponse> {
  return postJson("/api/setup/admin", input, (value) => SetupAdminResponse.parse(value));
}

// Signs in; the server sets the session cookie, so nothing secret is handled here.
export function signIn(input: LoginRequest): Promise<LoginResponse> {
  return postJson("/api/auth/login", input, (value) => LoginResponse.parse(value));
}

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
