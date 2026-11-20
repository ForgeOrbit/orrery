import { LoginResponse, SetupAdminResponse } from "@orrery/contract";
import type { LoginRequest, SetupAdminRequest } from "@orrery/contract";
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
