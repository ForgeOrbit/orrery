import { WorkSession } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, getJson } from "../../lib/api.ts";

// The current session for one issue. "No session recorded" is an expected empty state,
// not a load error, so the 409 that the read route returns for it becomes null. Polling
// keeps the stopping badge live while an agent works (design doc: 3-5 second MVP polling).
export const sessionQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "work-session"],
    queryFn: async (): Promise<WorkSession | null> => {
      try {
        return await getJson(`/api/issues/${encodeURIComponent(issueId)}/work-sessions`, (value) =>
          WorkSession.parse(value),
        );
      } catch (error) {
        if (error instanceof ApiProblemError && (error.status === 409 || error.status === 404)) {
          return null;
        }
        throw error;
      }
    },
    refetchInterval: 4000,
  });
