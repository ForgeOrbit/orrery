import { WorkspacesResponse } from "@orrery/contract";
import type { Workspace } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

// Query definitions for this feature, shared by routes and components so they use one
// cache key. Responses are parsed with the contract's zod schemas, so a server change
// can't slip through.

export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: async (): Promise<Workspace[]> => {
    const res = await fetch("/api/workspaces");
    // No cookie or an expired session is a normal state, not an error.
    if (res.status === 401) return [];
    if (!res.ok) throw new Error(`Workspaces check failed (${res.status}).`);
    return WorkspacesResponse.parse(await res.json());
  },
});
