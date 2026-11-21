import {
  ChangePasswordResponse,
  LoginResponse,
  LogoutResponse,
  SessionResponse,
  SetupAdminResponse,
} from "@orrery/contract";
import type {
  ChangePasswordRequest,
  LoginRequest,
  SetupAdminRequest,
  UpdateProfileRequest,
} from "@orrery/contract";
import { patchJson, post, postJson } from "../../lib/api.ts";

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

// Signs out and revokes the current browser session.
export function signOut(): Promise<LogoutResponse> {
  return post("/api/auth/logout", (value) => LogoutResponse.parse(value));
}

// Updates the signed-in account's profile (currently display name).
export function updateProfile(input: UpdateProfileRequest): Promise<SessionResponse> {
  return patchJson("/api/account/profile", input, (value) => SessionResponse.parse(value));
}

// Changes the signed-in account's password and revokes other browser sessions.
export function changePassword(input: ChangePasswordRequest): Promise<ChangePasswordResponse> {
  return postJson("/api/account/password", input, (value) => ChangePasswordResponse.parse(value));
}
