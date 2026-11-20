import { queryOptions } from "@tanstack/react-query";
import { HistoryResponse } from "@orrery/contract";
import { getJson } from "../../lib/api.ts";

// Query definitions for the history views, shared by routes and components so they use one
// cache key. Responses are parsed with the contract's zod schemas, so a server change
// cannot slip through as an unchecked object.
export const workspaceHistoryQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["history", "workspace", workspaceId],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/history`, (value) =>
        HistoryResponse.parse(value),
      ),
  });

export const projectHistoryQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["history", "project", projectId],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/history`, (value) =>
        HistoryResponse.parse(value),
      ),
  });

// Installation history is administrator-only. A signed-in ordinary account gets 403 and
// an anonymous one 401; both are normal states for the optional admin section, so null
// says "this account does not manage installation history" without a second client check.
export const installationHistoryQuery = queryOptions({
  queryKey: ["history", "installation"],
  queryFn: async () => {
    const res = await fetch("/api/installation/history");
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`Installation history failed (${res.status}).`);
    return HistoryResponse.parse(await res.json());
  },
});
