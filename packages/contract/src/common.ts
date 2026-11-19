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

// An instant as an ISO 8601 string. Responses carry UTC (`Z`) timestamps, which is what
// a database timestamp with time zone serializes to.
export const Timestamp = z.iso.datetime().meta({ id: "Timestamp" });
export type Timestamp = z.infer<typeof Timestamp>;

// Every REST error response is an RFC 9457 Problem Details object, served as
// application/problem+json (ADR-0003). `code` is the stable, machine-readable reason
// clients branch on; `type` is the same reason as a URI; `title` is its human summary.
// Nothing else is ever included, so internals (and secrets) never leak into responses.
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export const ProblemCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .meta({ id: "ProblemCode" });
export type ProblemCode = z.infer<typeof ProblemCode>;

// The problem type URI for a code. A URN: a stable identifier that needs no domain,
// because every Orrery installation is self-hosted.
export const problemType = (code: ProblemCode) => `urn:orrery:problem:${code}`;

// One invalid request field. `pointer` is an RFC 6901 JSON Pointer into the request
// body, for example "/email".
export const FieldError = z
  .object({ pointer: z.string(), detail: z.string() })
  .meta({ id: "FieldError" });
export type FieldError = z.infer<typeof FieldError>;

export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    code: ProblemCode,
    errors: z.array(FieldError).optional(),
  })
  .meta({ id: "Problem" });
export type Problem = z.infer<typeof Problem>;
