import { z } from "zod";
import { Email, LoginEmail, LoginPassword } from "./common.ts";

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

// The signed-in account behind the browser's session cookie. `emailVerified` reports
// whether the mailbox has been verified (issue #22); an administrator signs in before
// verifying, so the two states are independent.
export const SessionResponse = z
  .object({
    email: Email,
    emailVerified: z.boolean(),
  })
  .meta({ id: "SessionResponse" });
export type SessionResponse = z.infer<typeof SessionResponse>;
