import { LoginResponse, Problem, SetupAdminResponse } from "@orrery/contract";
import type { LoginRequest, SetupAdminRequest } from "@orrery/contract";

// Mutations for this feature. Each posts JSON, parses the response with the contract's
// schemas, and turns a Problem (RFC 9457) response into a plain Error carrying its most
// specific human text, so the routes can render the failure without knowing anything
// about the transport.

async function postJson<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = Problem.safeParse(await res.json().catch(() => null));
    if (!problem.success) throw new Error(`Request failed (${res.status}).`);
    const { title, detail, errors } = problem.data;
    throw new Error(errors?.[0]?.detail ?? detail ?? title);
  }
  return parse(await res.json());
}

// Creates the first system administrator and closes setup. Succeeds exactly once.
export function createFirstAdministrator(input: SetupAdminRequest): Promise<SetupAdminResponse> {
  return postJson("/api/setup/admin", input, (value) => SetupAdminResponse.parse(value));
}

// Signs in; the server sets the session cookie, so nothing secret is handled here.
export function signIn(input: LoginRequest): Promise<LoginResponse> {
  return postJson("/api/auth/login", input, (value) => LoginResponse.parse(value));
}
