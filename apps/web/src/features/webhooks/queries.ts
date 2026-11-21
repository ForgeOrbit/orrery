import { WebhookDeliveriesResponse, WebhooksResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { ApiProblemError, getJson } from "../../lib/api.ts";

export function webhooksQueryKey(workspaceId: string) {
  return ["workspaces", workspaceId, "webhooks"] as const;
}

const parseWebhooks = (value: unknown) => WebhooksResponse.parse(value);
const parseDeliveries = (value: unknown) => WebhookDeliveriesResponse.parse(value);

const retryNonAuth = (count: number, error: unknown) =>
  !(
    error instanceof ApiProblemError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  ) && count < 2;

export function workspaceWebhooksQuery(workspaceId: string) {
  return queryOptions({
    queryKey: webhooksQueryKey(workspaceId),
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks`, parseWebhooks),
    retry: retryNonAuth,
  });
}

export function webhookDeliveriesQuery(workspaceId: string, webhookId: string, polling = false) {
  return queryOptions({
    queryKey: [...webhooksQueryKey(workspaceId), webhookId, "deliveries"] as const,
    queryFn: () =>
      getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
        parseDeliveries,
      ),
    refetchInterval: polling ? 5_000 : false,
    retry: retryNonAuth,
  });
}
