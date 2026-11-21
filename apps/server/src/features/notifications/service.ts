import { randomUUID } from "node:crypto";
import { NotificationKind, ProjectAccessLevel, type NotificationsResponse } from "@orrery/contract";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agents, humans, issues, notifications, projects } from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { Logger } from "../../platform/log.ts";

export type NotificationsErrorKind =
  | "not_signed_in"
  | "agents_cannot_use_notifications"
  | "notification_not_found";

const messages: Record<NotificationsErrorKind, string> = {
  not_signed_in: "Sign in as a human to read notifications.",
  agents_cannot_use_notifications: "Only humans may use notifications.",
  notification_not_found: "No such notification is accessible to the caller.",
};

export class NotificationsError extends Error {
  readonly kind: NotificationsErrorKind;

  constructor(kind: NotificationsErrorKind) {
    super(messages[kind]);
    this.name = "NotificationsError";
    this.kind = kind;
  }
}

export type NotificationsProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export interface NotificationsDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: NotificationsProjectAccessCeiling;
  projectAccessAtLeast: (actual: ProjectAccessLevel, required: ProjectAccessLevel) => boolean;
  log: Logger;
}

export interface ActivityNotificationInput {
  activityId: string;
  projectId: string;
  issueId: string;
  kind: NotificationKind;
  summary: string;
  actorHumanId?: string | null;
  actorAgentId?: string | null;
}

/**
 * Writes the notifications for a project activity inside the very same transaction that
 * wrote the activity row. Every feature that records a notifiable activity calls this.
 */
export type NotifyActivity = (tx: DbTransaction, input: ActivityNotificationInput) => Promise<void>;

export interface ListNotificationsInput {
  unreadOnly?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface NotificationsService {
  createForActivity: NotifyActivity;
  list(humanId: string, input?: ListNotificationsInput): Promise<NotificationsResponse>;
  markRead(humanId: string, notificationId: string): Promise<void>;
  markAllRead(humanId: string): Promise<number>;
  prune(): Promise<number>;
}

type AccessibleRow = {
  id: string;
  kind: string;
  summary: string;
  readAt: Date | null;
  createdAt: Date;
  projectId: string;
  projectKey: string;
  projectName: string;
  workspaceId: string;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
};

async function callerIsActive(tx: DbTransaction, humanId: string): Promise<boolean> {
  const [caller] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .limit(1);
  return caller !== undefined;
}

export function createNotificationsService(deps: NotificationsDeps): NotificationsService {
  const { db } = deps;

  const hasReadAccess = async (
    tx: DbTransaction,
    humanId: string,
    workspaceId: string,
    projectId: string,
  ): Promise<boolean> => {
    const ceiling = await deps.projectAccessCeiling(tx, workspaceId, humanId, [projectId]);
    const level = ceiling.get(projectId) ?? null;
    return level !== null && deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read);
  };

  const createForActivity: NotifyActivity = async (tx, input) => {
    const [issue] = await tx
      .select({
        assigneeType: issues.assigneeType,
        assigneeId: issues.assigneeId,
        createdByHumanId: issues.createdByHumanId,
      })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .limit(1);
    if (issue === undefined) return;

    const [project] = await tx
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (project === undefined) return;

    const recipients = new Set<string>();
    if (input.actorAgentId !== null && input.actorAgentId !== undefined) {
      const [owner] = await tx
        .select({ humanId: agents.humanId })
        .from(agents)
        .where(eq(agents.id, input.actorAgentId))
        .limit(1);
      if (owner !== undefined) recipients.add(owner.humanId);
    }
    if (issue.assigneeType === "human" && issue.assigneeId !== null) {
      recipients.add(issue.assigneeId);
    }
    // A handoff with no human assignee also notifies the issue's human creator (if any).
    if (
      input.kind === "handoff" &&
      issue.assigneeType !== "human" &&
      issue.createdByHumanId !== null
    ) {
      recipients.add(issue.createdByHumanId);
    }
    if (input.actorHumanId !== null && input.actorHumanId !== undefined) {
      recipients.delete(input.actorHumanId);
    }
    if (recipients.size === 0) return;

    const live = await tx
      .select({ id: humans.id })
      .from(humans)
      .where(and(inArray(humans.id, [...recipients]), isNull(humans.deactivatedAt)));
    for (const { id: humanId } of live) {
      if (!(await hasReadAccess(tx, humanId, project.workspaceId, input.projectId))) continue;
      await tx
        .insert(notifications)
        .values({
          id: randomUUID(),
          humanId,
          projectId: input.projectId,
          issueId: input.issueId,
          activityId: input.activityId,
          kind: input.kind,
          summary: input.summary,
          createdAt: sql`statement_timestamp()`,
        })
        .onConflictDoNothing();
    }
  };

  const accessibleRows = async (tx: DbTransaction, humanId: string): Promise<AccessibleRow[]> => {
    if (!(await callerIsActive(tx, humanId))) return [];
    const rows = await tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        summary: notifications.summary,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        projectId: projects.id,
        projectKey: projects.key,
        projectName: projects.name,
        workspaceId: projects.workspaceId,
        issueId: issues.id,
        issueNumber: issues.number,
        issueTitle: issues.title,
      })
      .from(notifications)
      .innerJoin(issues, eq(issues.id, notifications.issueId))
      .innerJoin(projects, eq(projects.id, notifications.projectId))
      .where(and(eq(notifications.humanId, humanId), isNull(issues.deletedAt)))
      .orderBy(desc(notifications.createdAt), desc(notifications.id));

    const byWorkspace = new Map<string, AccessibleRow[]>();
    for (const row of rows) {
      const bucket = byWorkspace.get(row.workspaceId) ?? [];
      bucket.push(row);
      byWorkspace.set(row.workspaceId, bucket);
    }
    const accessible: AccessibleRow[] = [];
    for (const [workspaceId, bucket] of byWorkspace) {
      const projectIds = [...new Set(bucket.map((row) => row.projectId))];
      const ceiling = await deps.projectAccessCeiling(tx, workspaceId, humanId, projectIds);
      for (const row of bucket) {
        const level = ceiling.get(row.projectId) ?? null;
        if (level !== null && deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read)) {
          accessible.push(row);
        }
      }
    }
    accessible.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return accessible;
  };

  return {
    createForActivity,

    async list(humanId, input = {}) {
      const limit = input.limit ?? 50;
      return db.transaction(
        async (tx) => {
          const accessible = await accessibleRows(tx, humanId);
          const unreadCount = accessible.filter((row) => row.readAt === null).length;
          const visible =
            input.unreadOnly === true
              ? accessible.filter((row) => row.readAt === null)
              : accessible;
          let start = 0;
          if (input.cursor !== null && input.cursor !== undefined && input.cursor !== "") {
            const index = visible.findIndex((row) => row.id === input.cursor);
            start = index === -1 ? 0 : index + 1;
          }
          const page = visible.slice(start, start + limit);
          const nextCursor = start + limit < visible.length ? (page.at(-1)?.id ?? null) : null;
          return {
            items: page.map((row) => ({
              id: row.id,
              kind: NotificationKind.parse(row.kind),
              summary: row.summary,
              readAt: row.readAt?.toISOString() ?? null,
              createdAt: row.createdAt.toISOString(),
              project: {
                id: row.projectId,
                key: row.projectKey,
                name: row.projectName,
                workspaceId: row.workspaceId,
              },
              issue: {
                id: row.issueId,
                number: row.issueNumber,
                key: `${row.projectKey}-${row.issueNumber}`,
                title: row.issueTitle,
              },
            })),
            unreadCount,
            nextCursor,
          };
        },
        { accessMode: "read only" },
      );
    },

    async markRead(humanId, notificationId) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            id: notifications.id,
            projectId: notifications.projectId,
            workspaceId: projects.workspaceId,
          })
          .from(notifications)
          .innerJoin(issues, eq(issues.id, notifications.issueId))
          .innerJoin(projects, eq(projects.id, notifications.projectId))
          .where(
            and(
              eq(notifications.id, notificationId),
              eq(notifications.humanId, humanId),
              isNull(issues.deletedAt),
            ),
          )
          .limit(1);
        if (row === undefined || !(await callerIsActive(tx, humanId))) {
          throw new NotificationsError("notification_not_found");
        }
        if (!(await hasReadAccess(tx, humanId, row.workspaceId, row.projectId))) {
          throw new NotificationsError("notification_not_found");
        }
        await tx
          .update(notifications)
          .set({ readAt: sql`coalesce(${notifications.readAt}, statement_timestamp())` })
          .where(eq(notifications.id, notificationId));
      });
    },

    async markAllRead(humanId) {
      return db.transaction(async (tx) => {
        const accessible = await accessibleRows(tx, humanId);
        const ids = accessible.filter((row) => row.readAt === null).map((row) => row.id);
        if (ids.length === 0) return 0;
        const updated = await tx
          .update(notifications)
          .set({ readAt: sql`statement_timestamp()` })
          .where(and(inArray(notifications.id, ids), isNull(notifications.readAt)))
          .returning({ id: notifications.id });
        return updated.length;
      });
    },

    async prune() {
      return db.transaction(async (tx) => {
        const removed = await tx
          .delete(notifications)
          .where(
            or(
              lt(notifications.readAt, sql`statement_timestamp() - interval '90 days'`),
              lt(notifications.createdAt, sql`statement_timestamp() - interval '180 days'`),
            ),
          )
          .returning({ id: notifications.id });
        return removed.length;
      });
    },
  };
}
