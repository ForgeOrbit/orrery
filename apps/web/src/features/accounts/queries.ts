import { SessionResponse, SetupStatus } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

// Query definitions for this feature, shared by routes and components so they use one
// cache key. Responses are parsed with the contract's zod schemas, so a server change
// can't slip through.

export const setupStatusQuery = queryOptions({
  queryKey: ["setup", "status"],
  queryFn: async () => SetupStatus.parse(await (await fetch("/api/setup/status")).json()),
});

export type Session = { signedIn: false } | { signedIn: true; email: string };

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: async (): Promise<Session> => {
    const res = await fetch("/api/auth/session");
    // No cookie or an expired session is a normal state, not an error.
    if (res.status === 401) return { signedIn: false };
    if (!res.ok) throw new Error(`Session check failed (${res.status}).`);
    const account = SessionResponse.parse(await res.json());
    return { signedIn: true, email: account.email };
  },
});
