import { z } from "zod";
import { Email, LoginEmail, LoginPassword, NewPassword } from "./common.ts";

// Browser sign-in with email and password. Any non-empty email string and password are
// accepted by shape and checked against what is stored; wrong, unknown, or malformed
// credentials all answer the same 401. A successful login sets an HttpOnly session
// cookie, and the credentials themselves never appear in a response.
export const LoginRequest = z
  .object({
    email: LoginEmail,
    password: LoginPassword,
  })
  .meta({ id: "LoginRequest" });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z
  .object({
    email: Email,
  })
  .meta({ id: "LoginResponse" });
export type LoginResponse = z.infer<typeof LoginResponse>;

export const DisplayName = z
  .string()
  .trim()
  .min(1, "Display name must not be blank.")
  .max(120, "Display name must be 120 characters or fewer.")
  .meta({ id: "DisplayName" });
export type DisplayName = z.infer<typeof DisplayName>;

// The signed-in account behind the browser's session cookie. `emailVerified` reports
// whether the mailbox has been verified (issue #22); an administrator signs in before
// verifying, so the two states are independent.
export const SessionResponse = z
  .object({
    email: Email,
    displayName: z.string().nullable().optional(),
    emailVerified: z.boolean(),
  })
  .meta({ id: "SessionResponse" });
export type SessionResponse = z.infer<typeof SessionResponse>;

export const UpdateProfileRequest = z
  .object({
    displayName: DisplayName.nullable(),
  })
  .meta({ id: "UpdateProfileRequest" });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export const ChangePasswordRequest = z
  .object({
    currentPassword: LoginPassword,
    newPassword: NewPassword,
  })
  .meta({ id: "ChangePasswordRequest" });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const ChangePasswordResponse = z
  .object({
    changed: z.literal(true),
  })
  .meta({ id: "ChangePasswordResponse" });
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponse>;

export const LogoutResponse = z
  .object({
    signedOut: z.literal(true),
  })
  .meta({ id: "LogoutResponse" });
export type LogoutResponse = z.infer<typeof LogoutResponse>;
