import { RunsResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

export const workspaceRunsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["runs", workspaceId],
    queryFn: () =>
      getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
        (value) => RunsResponse.parse(value).runs,
      ),
  });
