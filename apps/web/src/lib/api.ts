import { Problem } from "@orrery/contract";

// One way the web app calls the API: send JSON or read one, parse a success with the
// caller's contract schema, and turn a Problem (RFC 9457) response into a plain Error
// carrying its most specific human text, so routes render failures without knowing
// anything about the transport. Accounts' and invitations' commands share this home.

async function failure(res: Response): Promise<never> {
  const problem = Problem.safeParse(await res.json().catch(() => null));
  if (!problem.success) throw new Error(`Request failed (${res.status}).`);
  const { title, detail, errors } = problem.data;
  throw new Error(errors?.[0]?.detail ?? detail ?? title);
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
