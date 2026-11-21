import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import type { Notification } from "@orrery/contract";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { sessionQuery } from "../features/accounts/index.ts";
import {
  markAllNotificationsRead,
  markNotificationRead,
  NotificationsEmptyState,
  NotificationsErrorState,
  NotificationsList,
  NotificationsLoadingState,
  notificationUnreadCountQuery,
  notificationsPageQuery,
  notificationsQueryKey,
} from "../features/notifications/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/notifications")({
  validateSearch: (search: Record<string, unknown>): { unreadOnly: boolean } => ({
    unreadOnly: search.unreadOnly === "true" || search.unreadOnly === true,
  }),
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  component: NotificationsPage,
  errorComponent: () => (
    <main>
      <Heading level={1} color="inherit">
        Notifications
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit" role="alert">
        Could not load notifications. Please try again.
      </Text>
    </main>
  ),
});

function NotificationsPage() {
  const { unreadOnly } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const feed = useInfiniteQuery(notificationsPageQuery(unreadOnly));
  const { data: unreadCount = 0 } = useQuery(notificationUnreadCountQuery);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
  };
  const readOne = useMutation({ mutationFn: markNotificationRead, onSuccess: invalidate });
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, onSuccess: invalidate });

  async function openNotification(notification: Notification) {
    if (notification.readAt === null) {
      try {
        await readOne.mutateAsync(notification.id);
      } catch {
        // Still take the person to the issue when marking read fails.
      }
    }
    await navigate({ to: "/issues/$issueId", params: { issueId: notification.issue.id } });
  }

  async function onMarkAll() {
    try {
      const result = await readAll.mutateAsync();
      toast({
        body: `Marked ${result.markedCount} notification${result.markedCount === 1 ? "" : "s"} read.`,
      });
    } catch (error) {
      toast({
        body: error instanceof Error ? error.message : "Could not mark notifications read.",
        type: "error",
      });
    }
  }

  const notifications = feed.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main data-notifications-page>
      <PageHeader
        title="Notifications"
        subtitle="Handoffs, questions needing input, and expired work sessions across your projects."
        badge={unreadCount > 0 ? `${unreadCount} unread` : undefined}
        actions={
          <Stack direction="horizontal" gap={2} wrap="wrap">
            <Stack direction="horizontal" gap={1} className="notification-filters" role="group">
              <Link
                to="/notifications"
                search={{ unreadOnly: true }}
                aria-current={unreadOnly ? "page" : undefined}
              >
                Unread
              </Link>
              <Link
                to="/notifications"
                search={{ unreadOnly: false }}
                aria-current={unreadOnly ? undefined : "page"}
              >
                All
              </Link>
            </Stack>
            <Button
              label="Mark all read"
              variant="secondary"
              size="sm"
              isDisabled={unreadCount === 0 || readAll.isPending}
              isLoading={readAll.isPending}
              onClick={() => void onMarkAll()}
            />
          </Stack>
        }
      />
      {feed.isPending ? (
        <NotificationsLoadingState />
      ) : feed.isError ? (
        <NotificationsErrorState error={feed.error} />
      ) : (
        <Section className="page-section" padding={3}>
          {notifications.length === 0 ? (
            <NotificationsEmptyState
              unreadOnly={unreadOnly}
              action={
                unreadOnly ? (
                  <Link to="/notifications" search={{ unreadOnly: false }}>
                    Show all notifications
                  </Link>
                ) : (
                  <Link to="/my-work">Go to My work</Link>
                )
              }
            />
          ) : (
            <>
              <NotificationsList
                notifications={notifications}
                onOpen={(notification) => void openNotification(notification)}
              />
              {feed.hasNextPage && (
                <Stack direction="horizontal" gap={2} className="notification-load-more">
                  <Button
                    label="Load more"
                    variant="secondary"
                    isLoading={feed.isFetchingNextPage}
                    isDisabled={feed.isFetchingNextPage}
                    onClick={() => void feed.fetchNextPage()}
                  />
                </Stack>
              )}
            </>
          )}
        </Section>
      )}
    </main>
  );
}
