import { Banner } from "@astryxdesign/core/Banner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Notification, NotificationKind } from "@orrery/contract";
import type { ReactNode } from "react";

const kindLabels: Record<NotificationKind, string> = {
  handoff: "Handoff",
  needs_input: "Needs input",
  session_expired: "Session expired",
};

export function relativeTime(value: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationRow({
  notification,
  onOpen,
}: {
  notification: Notification;
  onOpen: (notification: Notification) => void;
}) {
  const unread = notification.readAt === null;
  const time = relativeTime(notification.createdAt);

  return (
    <ListItem
      className="notification-row"
      data-notification-id={notification.id}
      data-notification-kind={notification.kind}
      data-unread={unread ? "true" : "false"}
      itemKey={notification.id}
      onClick={() => onOpen(notification)}
      label={
        <Stack direction="horizontal" gap={2} wrap="wrap" className="notification-row-label">
          <Text type="label" color="inherit" data-notification-kind-label>
            {kindLabels[notification.kind]}
          </Text>
          <Text type="inherit" color="inherit" data-notification-identifier>
            {notification.issue.identifier}
          </Text>
          <Text type="supporting" color="inherit" data-notification-summary>
            {notification.summary}
          </Text>
        </Stack>
      }
      description={
        <Text type="supporting" color="inherit">
          {notification.issue.title} · {notification.project.key} ·{" "}
          <time dateTime={notification.createdAt}>{time}</time> · {unread ? "Unread" : "Read"}
        </Text>
      }
    />
  );
}

export function NotificationsList({
  notifications,
  onOpen,
}: {
  notifications: Notification[];
  onOpen: (notification: Notification) => void;
}) {
  return (
    <List density="compact" hasDividers>
      {notifications.map((notification) => (
        <NotificationRow key={notification.id} notification={notification} onOpen={onOpen} />
      ))}
    </List>
  );
}

export function NotificationsLoadingState() {
  return (
    <Text as="p" display="block" type="supporting" role="status">
      Loading notifications…
    </Text>
  );
}

export function NotificationsEmptyState({
  unreadOnly,
  action,
}: {
  unreadOnly: boolean;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      title={unreadOnly ? "You're all caught up" : "No notifications yet"}
      description={
        unreadOnly
          ? "There are no unread notifications. Switch to All to review earlier updates."
          : "Handoffs, questions that need input, and expired work sessions will appear here."
      }
      actions={action}
      headingLevel={2}
    />
  );
}

export function NotificationsErrorState({ error }: { error: unknown }) {
  const detail = error instanceof Error ? error.message : "Check your connection and try again.";
  return (
    <Banner
      container="section"
      status="error"
      title="Could not load notifications"
      description={detail}
      collapsible={false}
    />
  );
}
