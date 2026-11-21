import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { List, ListItem } from "@astryxdesign/core/List";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { Notification, NotificationKind } from "@orrery/contract";
import type { ReactNode } from "react";
import { useRef } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { Link } from "../../lib/Link.tsx";

const kindTokens: Record<NotificationKind, { label: string; color: "blue" | "orange" | "red" }> = {
  handoff: { label: "Handoff", color: "blue" },
  needs_input: { label: "Needs input", color: "orange" },
  session_expired: { label: "Session expired", color: "red" },
};

export function relativeTime(value: string, now: number = Date.now()): string {
  const ms = now - new Date(value).getTime();
  if (Number.isNaN(ms)) return value;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationRow({
  notification,
  onRead,
}: {
  notification: Notification;
  onRead: (id: string) => void;
}) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const unread = notification.readAt === null;
  const kind = kindTokens[notification.kind];
  const time = relativeTime(notification.createdAt);

  return (
    <ListItem
      className="notification-row"
      data-notification-id={notification.id}
      data-notification-kind={notification.kind}
      data-unread={unread ? "true" : "false"}
      itemKey={notification.id}
      interactiveRef={linkRef}
      label={
        <Link
          ref={linkRef}
          to="/issues/$issueId"
          params={{ issueId: notification.issue.id }}
          onClick={() => {
            if (unread) onRead(notification.id);
          }}
        >
          <Stack as="span" direction="horizontal" gap={2} wrap="wrap">
            <Token label={kind.label} color={kind.color} size="sm" data-notification-kind-label />{" "}
            <Text
              as="span"
              className="issue-key"
              type="inherit"
              color={unread ? "primary" : "secondary"}
              data-notification-identifier
            >
              {notification.issue.identifier}
            </Text>{" "}
            <Text
              as="span"
              type="supporting"
              color={unread ? "primary" : "secondary"}
              data-notification-summary
            >
              {notification.summary}
            </Text>
          </Stack>
        </Link>
      }
      description={
        <Text as="span" type="supporting" color={unread ? "primary" : "secondary"}>
          {notification.issue.title} · {notification.project.key} ·{" "}
          <time
            dateTime={notification.createdAt}
            title={new Date(notification.createdAt).toLocaleString()}
          >
            {time}
          </time>{" "}
          · {unread ? "Unread" : "Read"}
        </Text>
      }
    />
  );
}

export function NotificationsList({
  notifications,
  onRead,
}: {
  notifications: Notification[];
  onRead: (id: string) => void;
}) {
  return (
    <List aria-label="Notifications" density="compact" hasDividers>
      {notifications.map((notification) => (
        <NotificationRow key={notification.id} notification={notification} onRead={onRead} />
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

export function NotificationsErrorState({
  error,
  onRetry,
  isCompact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  isCompact?: boolean;
}) {
  const detail =
    error instanceof ApiProblemError
      ? (error.problem.errors?.[0]?.detail ?? error.problem.detail ?? error.problem.title)
      : "Check your connection and try again.";
  return (
    <Banner
      container={isCompact ? "card" : "section"}
      status="error"
      title="Could not load notifications"
      description={detail}
      collapsible={false}
      endContent={
        onRetry === undefined ? undefined : (
          <Button label="Retry" variant="secondary" size="sm" onClick={onRetry} />
        )
      }
    />
  );
}
