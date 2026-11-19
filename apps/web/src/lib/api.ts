import { Problem } from "@orrery/contract";

// One way the web app calls the API: post JSON, parse the response with the caller's
// contract schema on success, and turn a Problem (RFC 9457) response into a plain Error
// carrying its most specific human text, so routes render failures without knowing
// anything about the transport. Accounts' and invitations' commands share this home.
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
  if (!res.ok) {
    const problem = Problem.safeParse(await res.json().catch(() => null));
    if (!problem.success) throw new Error(`Request failed (${res.status}).`);
    const { title, detail, errors } = problem.data;
    throw new Error(errors?.[0]?.detail ?? detail ?? title);
  }
  return parse(await res.json());
}
