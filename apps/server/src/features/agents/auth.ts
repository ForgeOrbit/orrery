import type { AgentIdentity } from "@orrery/contract";

// The narrow seam other features use to authenticate an agent key. `null` means the
// request carried no bearer credential; an invalid, revoked, or expired key throws, so a
// caller never silently falls back to a human session.
export type AgentAuthenticator = (request: Request) => Promise<AgentIdentity | null>;

// The one place a bearer header is parsed. Kept free of feature imports so projects can
// borrow it without a dependency cycle.
export function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  return /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? null;
}

// A structural guard lets the projects adapters map an agent failure without importing
// the agents service (which would close a feature dependency cycle).
export function isAgentError(error: unknown): error is Error & { kind: string } {
  return error instanceof Error && error.name === "AgentsError" && "kind" in error;
}
