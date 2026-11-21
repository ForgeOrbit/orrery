import { NotificationsResponse } from "@orrery/contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { ApiProblemError, getJson } from "../../lib/api.ts";

export const notificationsQueryKey = ["notifications"] as const;

const parse = (value: unknown) => NotificationsResponse.parse(value);
const parseUnreadCount = (value: unknown) => parse(value).unreadCount;

export function notificationsPageQuery(unreadOnly: boolean) {
  return infiniteQueryOptions({
    queryKey: [...notificationsQueryKey, "list", unreadOnly ? "unread" : "all"] as const,
    queryFn: ({ pageParam }) => {
      const cursor = pageParam === null ? "" : `&cursor=${encodeURIComponent(pageParam)}`;
      return getJson(
        `/api/notifications?unreadOnly=${unreadOnly ? "true" : "false"}&limit=50${cursor}`,
        parse,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
}

export const notificationUnreadCountQuery = queryOptions({
  queryKey: [...notificationsQueryKey, "unread-count"] as const,
  queryFn: () => getJson("/api/notifications?unreadOnly=true&limit=1", parseUnreadCount),
  refetchInterval: 15_000,
  retry: (failureCount, error) => {
    if (error instanceof ApiProblemError && (error.status === 401 || error.status === 403))
      return false;
    return failureCount < 3;
  },
});
