import { RunsResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

// Runs are workspace-scoped and read by a human session. Secrets are never part of a
// run; only reported metadata is shown, and a missing value stays `unknown`.
export const workspaceRunsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["runs", workspaceId],
    queryFn: () =>
      getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
        (value) => RunsResponse.parse(value).runs,
      ),
  });
