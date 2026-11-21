import {
  ActiveWorkSessionsResponse,
  SessionActivitiesResponse,
  WorkSession,
  WorkSessionsResponse,
} from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, getJson } from "../../lib/api.ts";

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

export const sessionsQuery = (issueId: string, open = false) =>
  queryOptions({
    queryKey: ["issues", issueId, "work-sessions"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/work-sessions/all`, (value) =>
        WorkSessionsResponse.parse(value),
      ),
    refetchInterval: open
      ? (query) =>
          query.state.data?.some((session) => session.status === "active") ? 4_000 : false
      : false,
  });

const emptyActivityCodes = new Set(["session_not_found", "issue_not_found"]);

export const sessionActivitiesQuery = (issueId: string, sessionId: string, active = false) =>
  queryOptions({
    queryKey: ["issues", issueId, "work-sessions", sessionId, "activities"],
    queryFn: async (): Promise<SessionActivitiesResponse> => {
      try {
        return await getJson(
          `/api/issues/${encodeURIComponent(issueId)}/work-sessions/${encodeURIComponent(sessionId)}/activities`,
          (value) => SessionActivitiesResponse.parse(value),
        );
      } catch (error) {
        if (error instanceof ApiProblemError && emptyActivityCodes.has(error.code)) return [];
        throw error;
      }
    },
    refetchInterval: active ? 4000 : false,
  });

export const activeSessionsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "active-work-sessions"],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/work-sessions/active`, (value) =>
        ActiveWorkSessionsResponse.parse(value),
      ),
    refetchInterval: 4000,
  });
