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

export async function postJson<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}

export async function patchJson<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failure(res);
  return parse(await res.json());
}
