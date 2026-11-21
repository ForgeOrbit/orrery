import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ListNotificationsQuery,
  MarkAllReadResponse,
  NotificationsResponse,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import {
  NotificationsError,
  type NotificationsErrorKind,
  type NotificationsService,
} from "./service.ts";

const notificationParams = z.object({ notificationId: z.string().min(1).max(200) });

const listNotifications = createRoute({
  method: "get",
  path: "/api/notifications",
  summary: "The signed-in human's in-app notifications",
  description:
    "Notifications for project activity that needs the caller's attention. Items for revoked projects, suspended memberships, deactivated humans and trashed issues are filtered out immediately, as is the unread count. Agent keys are rejected.",
  request: { query: ListNotificationsQuery },
  responses: {
    200: {
      description: "A page of notifications and the caller's total unread count",
      content: { "application/json": { schema: NotificationsResponse } },
    },
    400: problem("The query is invalid"),
    401: problem("Not signed in"),
    403: problem("Agent keys cannot read notifications"),
  },
});

const markNotificationRead = createRoute({
  method: "post",
  path: "/api/notifications/{notificationId}/read",
  summary: "Mark one notification read",
  description:
    "Idempotently sets the notification's read time. A notification the caller does not own or can no longer access answers exactly like a missing one.",
  request: { params: notificationParams },
  responses: {
    204: { description: "The notification is read" },
    400: problem("The notification id is invalid"),
    401: problem("Not signed in"),
    403: problem("Agent keys cannot read notifications"),
    404: problem("No such notification is accessible to the caller"),
  },
});

const markAllNotificationsRead = createRoute({
  method: "post",
  path: "/api/notifications/read-all",
  summary: "Mark every accessible notification read",
  description:
    "Marks all currently accessible unread notifications for the caller read and reports how many changed.",
  responses: {
    200: {
      description: "The number of notifications marked read",
      content: { "application/json": { schema: MarkAllReadResponse } },
    },
    401: problem("Not signed in"),
    403: problem("Agent keys cannot read notifications"),
  },
});

export const routes = [listNotifications, markNotificationRead, markAllNotificationsRead];

const statusFor = {
  not_signed_in: 401,
  agents_cannot_use_notifications: 403,
  notification_not_found: 404,
} as const satisfies Record<NotificationsErrorKind, number>;

function isKind<K extends readonly NotificationsErrorKind[]>(
  error: NotificationsError,
  kinds: K,
): error is NotificationsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

function failure<K extends readonly NotificationsErrorKind[]>(
  c: Context,
  error: unknown,
  kinds: K,
) {
  if (error instanceof NotificationsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

const listKinds = ["not_signed_in", "agents_cannot_use_notifications"] as const;
const readKinds = [
  "not_signed_in",
  "agents_cannot_use_notifications",
  "notification_not_found",
] as const;
const readAllKinds = ["not_signed_in", "agents_cannot_use_notifications"] as const;

async function humanIdOf(c: Context, sessionReader: SessionReader): Promise<string> {
  // Notification endpoints are human-only; a bearer agent key never reaches the service.
  if (/^Bearer\s+/i.test(c.req.header("authorization") ?? "")) {
    throw new NotificationsError("agents_cannot_use_notifications");
  }
  const account = await sessionReader(c);
  if (account === null) throw new NotificationsError("not_signed_in");
  return account.humanId;
}

export function createNotificationsRest(
  service: NotificationsService,
  sessionReader: SessionReader,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(listNotifications, async (c) => {
    try {
      const humanId = await humanIdOf(c, sessionReader);
      const query = c.req.valid("query");
      return c.json(
        await service.list(humanId, {
          unreadOnly: query.unreadOnly === "true",
          limit: query.limit,
          cursor: query.cursor ?? null,
        }),
        200,
      );
    } catch (error) {
      return failure(c, error, listKinds);
    }
  });

  app.openapi(markNotificationRead, async (c) => {
    try {
      const humanId = await humanIdOf(c, sessionReader);
      await service.markRead(humanId, c.req.valid("param").notificationId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, readKinds);
    }
  });

  app.openapi(markAllNotificationsRead, async (c) => {
    try {
      const humanId = await humanIdOf(c, sessionReader);
      return c.json({ markedCount: await service.markAllRead(humanId) }, 200);
    } catch (error) {
      return failure(c, error, readAllKinds);
    }
  });

  return app;
}
