import { z } from "zod";

// Field schemas shared by setup and authentication. Email keeps one normalization for
// the whole installation: trim, then lowercase, with no provider rewriting.
export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email()).meta({ id: "Email" });
export type Email = z.infer<typeof Email>;

// Setup chooses a new password; it must be at least 8 characters.
export const NewPassword = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(256)
  .meta({ id: "NewPassword" });
export type NewPassword = z.infer<typeof NewPassword>;

// Login accepts any non-empty email string and password: the credentials are simply
// checked against what is stored, so a malformed or overlong attempt falls through to
// the same uniform "invalid credentials" answer as a wrong one. The caps only bound
// the work of parsing; the request's body-size limit is the real guard.
export const LoginEmail = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(1024)
  .meta({ id: "LoginEmail" });
export type LoginEmail = z.infer<typeof LoginEmail>;

export const LoginPassword = z
  .string()
  .min(1)
  .max(1024)
  .meta({ id: "LoginPassword" });
export type LoginPassword = z.infer<typeof LoginPassword>;

// A workspace is personal (one private owner) or shared (invited members).
export const WorkspaceKind = z
  .enum(["personal", "shared"])
  .meta({ id: "WorkspaceKind" });
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

// Every error response, in every transport, is a Problem: a short, human-readable
// message and nothing else, so internals (and secrets) never leak into responses.
export const Problem = z.object({ message: z.string() }).meta({ id: "Problem" });
export type Problem = z.infer<typeof Problem>;
