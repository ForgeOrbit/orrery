import { Problem, type Problem as ProblemDetails } from "@orrery/contract";

// One way the web app calls the API: send JSON or read one, parse a success with the
// caller's contract schema, and turn a Problem (RFC 9457) response into a typed error
// carrying the stable code, status, and most specific human text, so routes render
// failures without knowing anything about the transport. A network failure stays the
// fetch/TypeError it is, distinct from a server Problem.

export class ApiProblemError extends Error {
  readonly code: string;
  readonly status: number;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.errors?.[0]?.detail ?? problem.detail ?? problem.title);
    this.name = "ApiProblemError";
    this.code = problem.code;
    this.status = problem.status;
    this.problem = problem;
  }
}

async function failure(res: Response): Promise<never> {
  const problem = Problem.safeParse(await res.json().catch(() => null));
  if (!problem.success) throw new Error(`Request failed (${res.status}).`);
  throw new ApiProblemError(problem.data);
}

export async function getJson<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

async function sendJson<T>(
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

export function postJson<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
  return sendJson("POST", path, body, parse);
}

// Replaces a resource wholesale. The caller supplies the complete body: an omitted field
// is not a partial update, so settings that are secrets (and never echoed back) must be
// supplied again by the client that saves them.
export function putJson<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
  return sendJson("PUT", path, body, parse);
}

// A POST whose success is a resource, with no request body (for actions whose target is
// entirely in the path).
export async function post<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

// A POST that answers 204, such as a recipient declining an invitation.
export async function postNoContent(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failure(res);
}

export function patchJson<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
): Promise<T> {
  return sendJson("PATCH", path, body, parse);
}

// A DELETE with no success body: 204 is the normal answer. A Problem still becomes the
// typed error every route renders the same way.
export async function deleteRequest(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) return failure(res);
}
