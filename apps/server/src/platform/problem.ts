// RFC 9457 Problem Details for every REST error (ADR-0003): one way to describe an error
// response in a route definition, one way to send it, and one way to turn a validation
// failure into it. Features use these; nothing builds an error body by hand.
import { type FieldError, PROBLEM_CONTENT_TYPE, Problem, problemType } from "@orrery/contract";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ProblemInput<S extends ContentfulStatusCode = ContentfulStatusCode> {
  status: S;
  code: string;
  title: string;
  detail?: string;
  errors?: FieldError[];
}

// A route's error response, for createRoute: `responses: { 409: problemContent("…") }`.
export const problemContent = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: Problem } },
});

// The Problem body for an error, with its type URI derived from the code.
export function toProblem({ status, code, title, detail, errors }: ProblemInput): Problem {
  return Problem.parse({
    type: problemType(code),
    title,
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined || errors.length === 0 ? {} : { errors }),
  });
}

// Sends a Problem with its status and the application/problem+json content type. Typed
// like c.json, so routes that declare the status accept it.
export function problemResponse<S extends ContentfulStatusCode>(
  c: Context,
  input: ProblemInput<S>,
) {
  return c.json(toProblem(input), input.status, { "content-type": PROBLEM_CONTENT_TYPE });
}

interface ValidationIssue {
  path: readonly PropertyKey[];
  message: string;
}

// RFC 6901: "~" and "/" inside a key are escaped.
const pointerTo = (path: readonly PropertyKey[]) =>
  path.map((key) => `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

// A failed request validation: 400 validation_failed, one entry per invalid field.
export function validationProblem(c: Context, issues: readonly ValidationIssue[]) {
  return problemResponse(c, {
    status: 400,
    code: "validation_failed",
    title: "The request is invalid.",
    errors: issues.map((issue) => ({ pointer: pointerTo(issue.path), detail: issue.message })),
  });
}

// The OpenAPIHono defaultHook every feature uses: validation failures become Problems.
export const validationHook = (
  result: { success: true } | { success: false; error: { issues: readonly ValidationIssue[] } },
  c: Context,
) => (result.success ? undefined : validationProblem(c, result.error.issues));

// The codes Hono's own errors get (for example a body that is not JSON).
const httpCodes: Partial<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  413: "payload_too_large",
  415: "unsupported_media_type",
};

export const codeForStatus = (status: number) => httpCodes[status] ?? "http_error";
