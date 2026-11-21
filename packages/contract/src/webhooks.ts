import { z } from "zod";
import { Timestamp } from "./common.ts";
import { ProjectActivityType } from "./projects.ts";

/** A webhook subscription's target. http:// is accepted at creation for operators who
 * deliberately opt in to private delivery with ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=true. */
export const WebhookUrl = z
  .url()
  .max(2048)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "https:" || parsed.protocol === "http:") &&
          parsed.username === "" &&
          parsed.password === ""
        );
      } catch {
        return false;
      }
    },
    { message: "The webhook URL must use http or https without embedded credentials." },
  )
  .meta({ id: "WebhookUrl" });
export type WebhookUrl = z.infer<typeof WebhookUrl>;

export const WebhookEvent = z
  .union([ProjectActivityType, z.literal("webhook.test")])
  .meta({ id: "WebhookEvent" });
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookDeliveryStatus = z
  .enum(["pending", "delivering", "delivered", "failed"])
  .meta({ id: "WebhookDeliveryStatus" });
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const Webhook = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    url: z.string(),
    description: z.string(),
    allProjects: z.boolean(),
    projectIds: z.array(z.string()),
    allEvents: z.boolean(),
    events: z.array(ProjectActivityType),
    enabled: z.boolean(),
    consecutiveFailures: z.int().nonnegative(),
    disabledAt: Timestamp.nullable(),
    disabledReason: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Webhook" });
export type Webhook = z.infer<typeof Webhook>;

/** Returned once, on creation and secret rotation only, and never stored in plaintext. */
export const WebhookWithSecret = Webhook.extend({
  signingSecret: z.string().startsWith("whsec_"),
}).meta({ id: "WebhookWithSecret" });
export type WebhookWithSecret = z.infer<typeof WebhookWithSecret>;

export const WebhooksResponse = z
  .object({ items: z.array(Webhook) })
  .meta({ id: "WebhooksResponse" });
export type WebhooksResponse = z.infer<typeof WebhooksResponse>;

const WebhookProjectIds = z.array(z.string().min(1)).max(1000);
const WebhookEvents = z.array(ProjectActivityType).max(100);

export const CreateWebhookRequest = z
  .object({
    url: WebhookUrl,
    description: z.string().max(500).default(""),
    allProjects: z.boolean(),
    projectIds: WebhookProjectIds.default([]),
    allEvents: z.boolean(),
    events: WebhookEvents.default([]),
  })
  .meta({ id: "CreateWebhookRequest" });
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;

export const UpdateWebhookRequest = z
  .object({
    url: WebhookUrl.optional(),
    description: z.string().max(500).optional(),
    allProjects: z.boolean().optional(),
    projectIds: WebhookProjectIds.optional(),
    allEvents: z.boolean().optional(),
    events: WebhookEvents.optional(),
    enabled: z.boolean().optional(),
  })
  .meta({ id: "UpdateWebhookRequest" });
export type UpdateWebhookRequest = z.infer<typeof UpdateWebhookRequest>;

export const WebhookDelivery = z
  .object({
    id: z.string(),
    webhookId: z.string(),
    event: WebhookEvent,
    activityId: z.string().nullable(),
    status: WebhookDeliveryStatus,
    attemptCount: z.int().nonnegative(),
    nextAttemptAt: Timestamp,
    lastStatusCode: z.int().nullable(),
    lastDurationMs: z.int().nonnegative().nullable(),
    lastError: z.string().nullable(),
    deliveredAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "WebhookDelivery" });
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

export const WebhookDeliveriesResponse = z
  .object({ items: z.array(WebhookDelivery) })
  .meta({ id: "WebhookDeliveriesResponse" });
export type WebhookDeliveriesResponse = z.infer<typeof WebhookDeliveriesResponse>;

/** The versioned, metadata-only body sent to receivers. No Markdown bodies are included. */
export const WebhookPayload = z
  .object({
    id: z.string(),
    version: z.literal(1),
    event: WebhookEvent,
    occurredAt: Timestamp,
    workspaceId: z.string(),
    project: z.object({ id: z.string(), key: z.string(), name: z.string() }),
    issue: z
      .object({
        id: z.string(),
        number: z.int(),
        identifier: z.string(),
        title: z.string(),
        status: z.string(),
      })
      .nullable(),
    knowledgeEntry: z.object({ id: z.string(), title: z.string() }).nullable(),
    actor: z.object({ kind: z.enum(["human", "agent", "system"]), id: z.string().nullable(), displayName: z.string() }),
    summary: z.string(),
  })
  .meta({ id: "WebhookPayload" });
export type WebhookPayload = z.infer<typeof WebhookPayload>;
