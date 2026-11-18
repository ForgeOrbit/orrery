import { z } from "zod";
import { Email, LoginPassword } from "./common.ts";

// Browser sign-in with email and password. A successful login sets an HttpOnly
// session cookie; the credentials themselves never appear in a response.
export const LoginRequest = z
  .object({
    email: Email,
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

// The signed-in account behind the browser's session cookie.
export const SessionResponse = z
  .object({
    email: Email,
  })
  .meta({ id: "SessionResponse" });
export type SessionResponse = z.infer<typeof SessionResponse>;
