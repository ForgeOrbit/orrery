import { NotificationsResponse } from "@orrery/contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

export const notificationsQueryKey = ["notifications"] as const;

const parse = (value: unknown) => NotificationsResponse.parse(value);

export function notificationsPageQuery(unreadOnly: boolean) {
  return infiniteQueryOptions({
    queryKey: [...notificationsQueryKey, "list", unreadOnly ? "unread" : "all"] as const,
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam === null ? "" : `&cursor=${encodeURIComponent(pageParam)}`;
      return parse(
        await getJson(
          `/api/notifications?unreadOnly=${unreadOnly ? "true" : "false"}&limit=50${cursor}`,
          (value) => value,
        ),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export const notificationUnreadCountQuery = queryOptions({
  queryKey: [...notificationsQueryKey, "unread-count"] as const,
  queryFn: async () =>
    parse(await getJson("/api/notifications?unreadOnly=true&limit=1", (value) => value))
      .unreadCount,
  refetchInterval: 15_000,
});
