import { queryOptions } from "@tanstack/react-query";
import { HistoryResponse } from "@orrery/contract";
import { getJson } from "../../lib/api.ts";

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

export const installationHistoryQuery = queryOptions({
  queryKey: ["history", "installation"],
  queryFn: async () => {
    const res = await fetch("/api/installation/history");
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`Installation history failed (${res.status}).`);
    return HistoryResponse.parse(await res.json());
  },
});
