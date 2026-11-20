import { ActiveWorkSessionsResponse, WorkSession } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, getJson } from "../../lib/api.ts";

// The current session for one issue. "No session recorded" and "issue not in scope" are
// expected empty states, not load failures: ADR-0003 calls them out by stable problem
// code, so branch on `code` rather than on a transport status that may change. Polling
// keeps the stopping badge live while an agent works (design doc: 3-5 second MVP polling).
const emptySessionCodes = new Set(["session_required", "issue_not_found"]);

export const sessionQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "work-session"],
    queryFn: async (): Promise<WorkSession | null> => {
      try {
        return await getJson(`/api/issues/${encodeURIComponent(issueId)}/work-sessions`, (value) =>
          WorkSession.parse(value),
        );
      } catch (error) {
        if (error instanceof ApiProblemError && emptySessionCodes.has(error.code)) return null;
        throw error;
      }
    },
    refetchInterval: 4000,
  });

// Only live sessions in projects the caller can read. The agents view renders this list
// instead of polling every issue of every project looking for one.
export const activeSessionsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "active-work-sessions"],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-sessions/active`, (value) =>
        ActiveWorkSessionsResponse.parse(value),
      ),
    refetchInterval: 4000,
  });
