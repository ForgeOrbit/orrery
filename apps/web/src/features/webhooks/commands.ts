import {
  Webhook,
  WebhookDelivery,
  WebhookWithSecret,
  type CreateWebhookRequest,
  type UpdateWebhookRequest,
} from "@orrery/contract";
import { deleteRequest, patchJson, post, postJson } from "../../lib/api.ts";

function basePath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks`;
}

export function createWebhook(
  workspaceId: string,
  input: CreateWebhookRequest,
): Promise<WebhookWithSecret> {
  return postJson(basePath(workspaceId), input, (value) => WebhookWithSecret.parse(value));
}

export function updateWebhook(
  workspaceId: string,
  webhookId: string,
  input: UpdateWebhookRequest,
): Promise<Webhook> {
  return patchJson(`${basePath(workspaceId)}/${encodeURIComponent(webhookId)}`, input, (value) =>
    Webhook.parse(value),
  );
}

export function rotateWebhookSecret(
  workspaceId: string,
  webhookId: string,
): Promise<WebhookWithSecret> {
  return post(`${basePath(workspaceId)}/${encodeURIComponent(webhookId)}/rotate-secret`, (value) =>
    WebhookWithSecret.parse(value),
  );
}

export function deleteWebhook(workspaceId: string, webhookId: string): Promise<void> {
  return deleteRequest(`${basePath(workspaceId)}/${encodeURIComponent(webhookId)}`);
}

export function sendTestWebhook(workspaceId: string, webhookId: string): Promise<WebhookDelivery> {
  return post(`${basePath(workspaceId)}/${encodeURIComponent(webhookId)}/test`, (value) =>
    WebhookDelivery.parse(value),
  );
}
