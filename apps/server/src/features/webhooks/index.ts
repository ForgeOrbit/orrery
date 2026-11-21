import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createWebhooksRest, routes } from "./rest.ts";
import {
  type EnqueueWebhookActivity,
  type WebhooksDeps,
  type WebhooksService,
  createWebhooksService,
} from "./service.ts";

export { routes as webhooksRoutes };
export { WebhooksError } from "./service.ts";
export type { EnqueueWebhookActivity, WebhooksErrorKind, WebhooksService } from "./service.ts";

export type WebhooksFeatureDeps = WebhooksDeps & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
};

export interface WebhooksFeature extends Feature {
  service: WebhooksService;
  enqueueForActivity: EnqueueWebhookActivity;
}

export function createWebhooksFeature(deps: WebhooksFeatureDeps): WebhooksFeature {
  const service = createWebhooksService(deps);
  return {
    name: "webhooks",
    rest: createWebhooksRest(service, deps.sessionReader, deps.authenticate),
    service,
    enqueueForActivity: service.enqueueForActivity,
    startBackgroundTasks: () => {
      let running = false;
      const tick = () => {
        if (running) return;
        running = true;
        void (async () => {
          try {
            await service.drain();
          } catch (error) {
            deps.log.warn("webhook outbox drain failed", { error: String(error) });
          } finally {
            running = false;
          }
        })();
      };
      service.setWakeup(tick);
      const poll = setInterval(tick, 2000);
      poll.unref();
      const prune = setInterval(
        () => {
          void service.prune().catch((error: unknown) => {
            deps.log.warn("webhook retention sweep failed", { error: String(error) });
          });
        },
        60 * 60 * 1000,
      );
      prune.unref();
    },
  };
}
