import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import {
  ProjectActivityType,
  WebhookEvent,
  type CreateWebhookRequest,
  type UpdateWebhookRequest,
  type Webhook,
  type WebhookDeliveriesResponse,
  type WebhookDelivery,
  type WebhookPayload,
  type WebhooksResponse,
  type WebhookWithSecret,
} from "@orrery/contract";
import { and, asc, desc, eq, exists, inArray, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agents,
  humans,
  issues,
  knowledgeEntries,
  projectActivity,
  projects,
  webhookDeliveries,
  webhookProjects,
  webhooks,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { Logger } from "../../platform/log.ts";
import { decryptSecret, encryptSecret } from "../../platform/secrets.ts";
import type { WorkActor } from "../projects/index.ts";

export const MAX_WEBHOOKS_PER_WORKSPACE = 20;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const AUTO_DISABLE_AFTER_FAILURES = 10;
const DELIVERY_TIMEOUT_MS = 10_000;
const PREVIEW_CHARS = 512;

/** Milliseconds to wait before attempt N (1-indexed). Attempt 1 is immediate. */
const BACKOFF_MS: readonly (number | null)[] = [
  0,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  null,
];

export type WebhooksErrorKind =
  | "not_signed_in"
  | "agents_cannot_manage_webhooks"
  | "not_workspace_member"
  | "not_workspace_owner"
  | "webhook_not_found"
  | "webhook_limit_reached"
  | "encryption_key_missing"
  | "invalid_webhook_scope";

const messages: Record<WebhooksErrorKind, string> = {
  not_signed_in: "Sign in as a human to manage webhooks.",
  agents_cannot_manage_webhooks: "Agent keys cannot manage webhooks.",
  not_workspace_member: "No such workspace is accessible to the caller.",
  not_workspace_owner: "Only a workspace owner can manage webhooks.",
  webhook_not_found: "No such webhook exists in this workspace.",
  webhook_limit_reached: "This workspace already has the maximum of 20 webhooks.",
  encryption_key_missing:
    "No encryption key is configured, so a signing secret cannot be generated. Set ORRERY_ENCRYPTION_KEY on the server and try again.",
  invalid_webhook_scope: "The selected projects must exist in this workspace.",
};

export class WebhooksError extends Error {
  readonly kind: WebhooksErrorKind;

  constructor(kind: WebhooksErrorKind) {
    super(messages[kind]);
    this.name = "WebhooksError";
    this.kind = kind;
  }
}

/** Writes the outbox for a project activity inside the transaction that wrote the activity. */
export type EnqueueWebhookActivity = (tx: DbTransaction, activityId: string) => Promise<void>;

export interface WebhooksDeps {
  db: PostgresJsDatabase;
  encryptionKey: Buffer | undefined;
  allowPrivateUrls: boolean;
  log: Logger;
}

export interface WebhooksService {
  list(actor: WorkActor | null, workspaceId: string): Promise<WebhooksResponse>;
  create(
    actor: WorkActor | null,
    workspaceId: string,
    input: CreateWebhookRequest,
  ): Promise<WebhookWithSecret>;
  update(
    actor: WorkActor | null,
    workspaceId: string,
    webhookId: string,
    input: UpdateWebhookRequest,
  ): Promise<Webhook>;
  rotateSecret(
    actor: WorkActor | null,
    workspaceId: string,
    webhookId: string,
  ): Promise<WebhookWithSecret>;
  remove(actor: WorkActor | null, workspaceId: string, webhookId: string): Promise<void>;
  test(actor: WorkActor | null, workspaceId: string, webhookId: string): Promise<WebhookDelivery>;
  deliveries(
    actor: WorkActor | null,
    workspaceId: string,
    webhookId: string,
  ): Promise<WebhookDeliveriesResponse>;
  enqueueForActivity: EnqueueWebhookActivity;
  /** Attempt all due deliveries. Returns the number of rows claimed. */
  drain(): Promise<number>;
  prune(): Promise<number>;
  /** Set by the feature to wake the worker right after a local enqueue. */
  setWakeup(fn: () => void): void;
}

type DeliveryAttemptResult =
  | { ok: true; status: number }
  | { ok: false; error: string; status?: number };

type Queryable = Pick<DbTransaction, "select">;

function expandIpv6(address: string): number[] {
  const [left = "", right = ""] = address.split("::");
  const head = left === "" ? [] : left.split(":");
  const tail = right === "" ? [] : right.split(":");
  const zeros = Math.max(0, 8 - head.length - tail.length);
  return [...head, ...Array(zeros).fill("0"), ...tail].map((group) =>
    Number.parseInt(group || "0", 16),
  );
}

function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 6) {
    const groups = expandIpv6(address.toLowerCase().replace(/^\[|\]$/g, ""));
    if (groups.length !== 8) return true;
    if (groups.every((group) => group === 0)) return true; // unspecified
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
    // IPv4-mapped addresses (URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1).
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      const high = groups[6] ?? 0;
      const low = groups[7] ?? 0;
      return isBlockedAddress(
        `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
      );
    }
    const first = groups[0] ?? 0;
    if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
    return false;
  }
  if (kind !== 4) return true;
  const [aRaw, bRaw] = address.split(".");
  const a = Number(aRaw);
  const b = Number(bRaw);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, including 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || b === 0)) return true; // private / IETF assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return false;
}

async function resolvePinnedAddress(url: URL, allowPrivateUrls: boolean): Promise<string> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (!allowPrivateUrls && isBlockedAddress(hostname)) throw new Error("blocked address");
    return hostname;
  }
  const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) throw new Error("no addresses");
  if (!allowPrivateUrls && resolved.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error("blocked address");
  }
  const chosen = resolved[0];
  if (chosen === undefined) throw new Error("no addresses");
  return chosen.address;
}

function sanitizeError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, PREVIEW_CHARS);
}

const noWakeup = () => {};

async function assertWebhookInWorkspace(
  q: Queryable,
  workspaceId: string,
  webhookId: string,
): Promise<void> {
  const [row] = await q
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.workspaceId, workspaceId)))
    .limit(1);
  if (row === undefined) throw new WebhooksError("webhook_not_found");
}

async function loadWebhook(q: Queryable, webhookId: string): Promise<Webhook> {
  const [row] = await q.select().from(webhooks).where(eq(webhooks.id, webhookId)).limit(1);
  if (row === undefined) throw new WebhooksError("webhook_not_found");
  const projectRows = await q
    .select({ projectId: webhookProjects.projectId })
    .from(webhookProjects)
    .where(eq(webhookProjects.webhookId, webhookId))
    .orderBy(asc(webhookProjects.projectId));
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    description: row.description,
    allProjects: row.allProjects,
    projectIds: projectRows.map((entry) => entry.projectId),
    allEvents: row.allEvents,
    events: row.events.map((event) => ProjectActivityType.parse(event)),
    enabled: row.enabled,
    consecutiveFailures: row.consecutiveFailures,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDelivery(row: typeof webhookDeliveries.$inferSelect): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    event: WebhookEvent.parse(row.event),
    activityId: row.activityId,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastStatusCode: row.lastStatusCode,
    lastDurationMs: row.lastDurationMs,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function buildEnvelope(
  tx: DbTransaction,
  activityId: string,
): Promise<WebhookPayload | null> {
  const [activity] = await tx
    .select()
    .from(projectActivity)
    .where(eq(projectActivity.id, activityId))
    .limit(1);
  if (activity === undefined) return null;
  const [project] = await tx
    .select({
      id: projects.id,
      key: projects.key,
      name: projects.name,
      workspaceId: projects.workspaceId,
    })
    .from(projects)
    .where(eq(projects.id, activity.projectId))
    .limit(1);
  if (project === undefined) return null;

  let issue: WebhookPayload["issue"] = null;
  if (activity.issueId !== null) {
    const [row] = await tx
      .select({ id: issues.id, number: issues.number, title: issues.title, status: issues.status })
      .from(issues)
      .where(eq(issues.id, activity.issueId))
      .limit(1);
    if (row !== undefined) {
      issue = {
        id: row.id,
        number: row.number,
        identifier: `${project.key}-${row.number}`,
        title: row.title,
        status: row.status,
      };
    }
  }

  let knowledgeEntry: WebhookPayload["knowledgeEntry"] = null;
  if (activity.knowledgeEntryId !== null) {
    const [row] = await tx
      .select({ id: knowledgeEntries.id, title: knowledgeEntries.title })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, activity.knowledgeEntryId))
      .limit(1);
    if (row !== undefined) knowledgeEntry = { id: row.id, title: row.title };
  }

  let actor: WebhookPayload["actor"] = { kind: "system", id: null, displayName: "System" };
  if (activity.actorHumanId !== null) {
    const [row] = await tx
      .select({ id: humans.id, displayName: humans.displayName, email: humans.email })
      .from(humans)
      .where(eq(humans.id, activity.actorHumanId))
      .limit(1);
    if (row !== undefined) {
      actor = { kind: "human", id: row.id, displayName: row.displayName ?? row.email };
    }
  } else if (activity.actorAgentId !== null) {
    const [row] = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, activity.actorAgentId))
      .limit(1);
    if (row !== undefined) actor = { kind: "agent", id: row.id, displayName: row.name };
  }

  return {
    id: activity.id,
    version: 1,
    event: WebhookEvent.parse(activity.type),
    occurredAt: activity.createdAt.toISOString(),
    workspaceId: project.workspaceId,
    project: { id: project.id, key: project.key, name: project.name },
    issue,
    knowledgeEntry,
    actor,
    summary: activity.summary,
  };
}

async function performHttpDelivery(
  url: URL,
  secret: string,
  delivery: typeof webhookDeliveries.$inferSelect,
  pinnedAddress: string,
): Promise<DeliveryAttemptResult> {
  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const headers: Record<string, string | number> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "Orrery-Webhooks/1",
    "x-orrery-delivery": delivery.id,
    "x-orrery-event": delivery.event,
    "x-orrery-timestamp": timestamp,
    "x-orrery-signature-256": `sha256=${signature}`,
    "content-length": Buffer.byteLength(rawBody),
  };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // Pinned lookup: resolve and validate DNS first, then connect to the exact validated
  // address so a DNS rebind cannot redirect the delivery.
  const lookup = (
    _hostname: string,
    _options: LookupOptions,
    callback: (error: Error | null, address: string, family: number) => void,
  ) => callback(null, pinnedAddress, isIP(pinnedAddress));
  const transport = url.protocol === "http:" ? http : https;
  return await new Promise<DeliveryAttemptResult>((resolve) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers,
        lookup,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      },
      (response) => {
        // Redirects are never followed: any 3xx is a failed delivery.
        const status = response.statusCode ?? 0;
        response.resume();
        response.on("end", () => {
          resolve(
            status >= 200 && status < 300
              ? { ok: true, status }
              : { ok: false, status, error: `http_${status}` },
          );
        });
      },
    );
    request.on("error", (error: Error) => {
      resolve({ ok: false, error: sanitizeError(error.message || "network_error") });
    });
    request.end(rawBody);
  });
}

export function createWebhooksService(deps: WebhooksDeps): WebhooksService {
  const { db, encryptionKey, log, allowPrivateUrls } = deps;
  let wakeup: () => void = noWakeup;

  /** Resolve the caller and assert workspace ownership. Never reveals membership to outsiders. */
  const requireOwner = async (actor: WorkActor | null, workspaceId: string): Promise<string> => {
    if (actor === null) throw new WebhooksError("not_signed_in");
    if (actor.kind === "agent") throw new WebhooksError("agents_cannot_manage_webhooks");
    const humanId = actor.account.humanId;
    const [workspace] = await db
      .select({ kind: workspaces.kind, personalOwnerHumanId: workspaces.personalOwnerHumanId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (workspace === undefined) throw new WebhooksError("not_workspace_member");
    if (workspace.kind === "personal") {
      if (workspace.personalOwnerHumanId !== humanId)
        throw new WebhooksError("not_workspace_member");
      return humanId;
    }
    const [membership] = await db
      .select({
        isOwner: workspaceMemberships.isOwner,
        suspendedAt: workspaceMemberships.suspendedAt,
      })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, humanId),
        ),
      )
      .limit(1);
    if (membership === undefined || membership.suspendedAt !== null) {
      throw new WebhooksError("not_workspace_member");
    }
    if (!membership.isOwner) throw new WebhooksError("not_workspace_owner");
    return humanId;
  };

  const enqueueForActivity: EnqueueWebhookActivity = async (tx, activityId) => {
    const payload = await buildEnvelope(tx, activityId);
    if (payload === null) return;
    const matching = await tx
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.workspaceId, payload.workspaceId),
          eq(webhooks.enabled, true),
          or(
            eq(webhooks.allProjects, true),
            exists(
              tx
                .select({ id: webhookProjects.webhookId })
                .from(webhookProjects)
                .where(
                  and(
                    eq(webhookProjects.webhookId, webhooks.id),
                    eq(webhookProjects.projectId, payload.project.id),
                  ),
                ),
            ),
          ),
          or(eq(webhooks.allEvents, true), sql`${payload.event} = any(${webhooks.events})`),
        ),
      );
    if (matching.length === 0) return;
    await tx.insert(webhookDeliveries).values(
      matching.map((hook) => ({
        id: randomUUID(),
        webhookId: hook.id,
        event: payload.event,
        activityId,
        payload,
        status: "pending" as const,
        nextAttemptAt: sql`statement_timestamp()`,
      })),
    );
    wakeup();
  };

  const attempt = async (
    hook: typeof webhooks.$inferSelect,
    delivery: typeof webhookDeliveries.$inferSelect,
  ): Promise<DeliveryAttemptResult> => {
    if (encryptionKey === undefined) return { ok: false, error: "webhook_secret_unreadable" };
    const secret = decryptSecret(encryptionKey, hook.secretEncrypted);
    if (secret === undefined) return { ok: false, error: "webhook_secret_unreadable" };
    let url: URL;
    try {
      url = new URL(hook.url);
    } catch {
      return { ok: false, error: "invalid_url" };
    }
    if (url.protocol !== "https:" && !(allowPrivateUrls && url.protocol === "http:")) {
      return { ok: false, error: "ssrf_blocked_scheme" };
    }
    try {
      const pinned = await resolvePinnedAddress(url, allowPrivateUrls);
      return await performHttpDelivery(url, secret, delivery, pinned);
    } catch {
      return { ok: false, error: "ssrf_blocked" };
    }
  };

  const finalize = async (
    delivery: typeof webhookDeliveries.$inferSelect,
    result: DeliveryAttemptResult,
    durationMs: number,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      if (result.ok) {
        await tx
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            deliveredAt: sql`statement_timestamp()`,
            lockedUntil: null,
            lastStatusCode: result.status,
            lastDurationMs: durationMs,
            lastError: null,
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        await tx
          .update(webhooks)
          .set({ consecutiveFailures: 0 })
          .where(eq(webhooks.id, delivery.webhookId));
        return;
      }

      const exhausted = delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS;
      const delay =
        delivery.attemptCount < BACKOFF_MS.length
          ? (BACKOFF_MS[delivery.attemptCount] ?? null)
          : null;
      const nextAttemptAt =
        exhausted || delay === null ? delivery.nextAttemptAt : new Date(Date.now() + delay);
      await tx
        .update(webhookDeliveries)
        .set({
          status: exhausted ? "failed" : "pending",
          nextAttemptAt,
          lockedUntil: null,
          lastStatusCode: result.status ?? null,
          lastDurationMs: durationMs,
          lastError: sanitizeError(result.error),
        })
        .where(eq(webhookDeliveries.id, delivery.id));

      // Synthetic test deliveries never drive the circuit breaker.
      if (!exhausted || delivery.event === "webhook.test") return;
      const [updated] = await tx
        .update(webhooks)
        .set({ consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` })
        .where(eq(webhooks.id, delivery.webhookId))
        .returning({ value: webhooks.consecutiveFailures });
      if (updated !== undefined && updated.value >= AUTO_DISABLE_AFTER_FAILURES) {
        await tx
          .update(webhooks)
          .set({
            enabled: false,
            disabledAt: new Date(),
            disabledReason: "consecutive_failures",
          })
          .where(and(eq(webhooks.id, delivery.webhookId), eq(webhooks.enabled, true)));
      }
    });
  };

  return {
    enqueueForActivity,

    setWakeup(fn) {
      wakeup = fn;
    },

    async list(actor, workspaceId) {
      await requireOwner(actor, workspaceId);
      const rows = await db
        .select()
        .from(webhooks)
        .where(eq(webhooks.workspaceId, workspaceId))
        .orderBy(desc(webhooks.createdAt), desc(webhooks.id));
      const items: Webhook[] = [];
      for (const row of rows) items.push(await loadWebhook(db, row.id));
      return { items };
    },

    async create(actor, workspaceId, input) {
      const humanId = await requireOwner(actor, workspaceId);
      return db.transaction(async (tx) => {
        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(webhooks)
          .where(eq(webhooks.workspaceId, workspaceId));
        if ((count?.value ?? 0) >= MAX_WEBHOOKS_PER_WORKSPACE) {
          throw new WebhooksError("webhook_limit_reached");
        }
        if (!input.allProjects && input.projectIds.length > 0) {
          const inWorkspace = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(eq(projects.workspaceId, workspaceId), inArray(projects.id, input.projectIds)),
            );
          if (inWorkspace.length !== new Set(input.projectIds).size) {
            throw new WebhooksError("invalid_webhook_scope");
          }
        }
        if (encryptionKey === undefined) throw new WebhooksError("encryption_key_missing");
        const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
        const id = randomUUID();
        await tx.insert(webhooks).values({
          id,
          workspaceId,
          url: input.url,
          description: input.description,
          secretEncrypted: encryptSecret(encryptionKey, signingSecret),
          allProjects: input.allProjects,
          allEvents: input.allEvents,
          events: input.events,
          createdByHumanId: humanId,
          updatedByHumanId: humanId,
          createdAt: sql`statement_timestamp()`,
          updatedAt: sql`statement_timestamp()`,
        });
        if (!input.allProjects && input.projectIds.length > 0) {
          await tx
            .insert(webhookProjects)
            .values(input.projectIds.map((projectId) => ({ webhookId: id, projectId })));
        }
        return { ...(await loadWebhook(tx, id)), signingSecret };
      });
    },

    async update(actor, workspaceId, webhookId, input) {
      const humanId = await requireOwner(actor, workspaceId);
      return db.transaction(async (tx) => {
        await assertWebhookInWorkspace(tx, workspaceId, webhookId);
        const set: Partial<typeof webhooks.$inferInsert> = {
          updatedByHumanId: humanId,
          updatedAt: new Date(),
        };
        if (input.url !== undefined) set.url = input.url;
        if (input.description !== undefined) set.description = input.description;
        if (input.allProjects !== undefined) set.allProjects = input.allProjects;
        if (input.allEvents !== undefined) set.allEvents = input.allEvents;
        if (input.events !== undefined) set.events = input.events;
        if (input.enabled !== undefined) {
          set.enabled = input.enabled;
          if (input.enabled) {
            set.disabledAt = null;
            set.disabledReason = null;
            set.consecutiveFailures = 0;
          } else {
            set.disabledAt = new Date();
            set.disabledReason = "disabled_by_owner";
          }
        }
        await tx.update(webhooks).set(set).where(eq(webhooks.id, webhookId));

        const effectiveAllProjects =
          input.allProjects ?? (await loadWebhook(tx, webhookId)).allProjects;
        if (input.projectIds !== undefined || input.allProjects === true) {
          if (
            !effectiveAllProjects &&
            input.projectIds !== undefined &&
            input.projectIds.length > 0
          ) {
            const inWorkspace = await tx
              .select({ id: projects.id })
              .from(projects)
              .where(
                and(eq(projects.workspaceId, workspaceId), inArray(projects.id, input.projectIds)),
              );
            if (inWorkspace.length !== new Set(input.projectIds).size) {
              throw new WebhooksError("invalid_webhook_scope");
            }
          }
          await tx.delete(webhookProjects).where(eq(webhookProjects.webhookId, webhookId));
          if (
            !effectiveAllProjects &&
            input.projectIds !== undefined &&
            input.projectIds.length > 0
          ) {
            await tx
              .insert(webhookProjects)
              .values(input.projectIds.map((projectId) => ({ webhookId, projectId })));
          }
        }
        return loadWebhook(tx, webhookId);
      });
    },

    async rotateSecret(actor, workspaceId, webhookId) {
      const humanId = await requireOwner(actor, workspaceId);
      if (encryptionKey === undefined) throw new WebhooksError("encryption_key_missing");
      return db.transaction(async (tx) => {
        await assertWebhookInWorkspace(tx, workspaceId, webhookId);
        const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
        await tx
          .update(webhooks)
          .set({
            secretEncrypted: encryptSecret(encryptionKey, signingSecret),
            updatedByHumanId: humanId,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(webhooks.id, webhookId));
        return { ...(await loadWebhook(tx, webhookId)), signingSecret };
      });
    },

    async remove(actor, workspaceId, webhookId) {
      await requireOwner(actor, workspaceId);
      await db.transaction(async (tx) => {
        await assertWebhookInWorkspace(tx, workspaceId, webhookId);
        await tx.delete(webhooks).where(eq(webhooks.id, webhookId));
      });
    },

    async test(actor, workspaceId, webhookId) {
      await requireOwner(actor, workspaceId);
      return db.transaction(async (tx) => {
        const hook = await loadWebhook(tx, webhookId);
        if (hook.workspaceId !== workspaceId) throw new WebhooksError("webhook_not_found");
        const payload: WebhookPayload = {
          id: randomUUID(),
          version: 1,
          event: "webhook.test",
          occurredAt: new Date().toISOString(),
          workspaceId,
          project: { id: "", key: "TEST", name: "Webhook test" },
          issue: null,
          knowledgeEntry: null,
          actor: { kind: "system", id: null, displayName: "System" },
          summary: "Synthetic webhook test event.",
        };
        const id = randomUUID();
        await tx.insert(webhookDeliveries).values({
          id,
          webhookId,
          event: "webhook.test",
          activityId: null,
          payload,
          status: "pending",
          nextAttemptAt: sql`statement_timestamp()`,
        });
        wakeup();
        const [row] = await tx
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, id))
          .limit(1);
        if (row === undefined) throw new WebhooksError("webhook_not_found");
        return toDelivery(row);
      });
    },

    async deliveries(actor, workspaceId, webhookId) {
      await requireOwner(actor, workspaceId);
      await assertWebhookInWorkspace(db, workspaceId, webhookId);
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, webhookId))
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(50);
      return { items: rows.map(toDelivery) };
    },

    async drain() {
      const claimed = await db.transaction(async (tx) => {
        const due = await tx
          .select()
          .from(webhookDeliveries)
          .where(
            or(
              and(
                eq(webhookDeliveries.status, "pending"),
                lte(webhookDeliveries.nextAttemptAt, sql`statement_timestamp()`),
              ),
              and(
                eq(webhookDeliveries.status, "delivering"),
                lte(webhookDeliveries.lockedUntil, sql`statement_timestamp()`),
              ),
            ),
          )
          .orderBy(asc(webhookDeliveries.nextAttemptAt))
          .limit(20)
          .for("update", { skipLocked: true });
        const result: typeof due = [];
        for (const row of due) {
          const attemptCount = row.status === "pending" ? row.attemptCount + 1 : row.attemptCount;
          await tx
            .update(webhookDeliveries)
            .set({
              status: "delivering",
              attemptCount,
              lockedUntil: sql`statement_timestamp() + interval '2 minutes'`,
            })
            .where(eq(webhookDeliveries.id, row.id));
          result.push({ ...row, attemptCount });
        }
        return result;
      });
      for (const delivery of claimed) {
        try {
          const [hook] = await db
            .select()
            .from(webhooks)
            .where(eq(webhooks.id, delivery.webhookId))
            .limit(1);
          if (hook === undefined) {
            await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
            continue;
          }
          const started = Date.now();
          const result = await attempt(hook, delivery);
          await finalize(delivery, result, Date.now() - started);
        } catch (error) {
          log.warn("webhook delivery attempt failed unexpectedly", {
            deliveryId: delivery.id,
            error: String(error),
          });
          await finalize(delivery, { ok: false, error: "internal_error" }, 0);
        }
      }
      return claimed.length;
    },

    async prune() {
      return db.transaction(async (tx) => {
        const removed = await tx
          .delete(webhookDeliveries)
          .where(lte(webhookDeliveries.createdAt, sql`statement_timestamp() - interval '30 days'`))
          .returning({ id: webhookDeliveries.id });
        return removed.length;
      });
    },
  };
}
