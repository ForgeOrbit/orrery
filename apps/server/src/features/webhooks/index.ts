import { errorSummary } from "../../platform/errors.ts";
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createWebhooksRest, routes } from "./rest.ts";
import {
  DRAIN_BATCH_SIZE,
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
      let rerun = false;
      const tick = () => {
        if (running) {
          rerun = true;
          return;
        }
        running = true;
        void (async () => {
          try {
            do {
              rerun = false;
              let claimed = await service.drain();
              while (claimed >= DRAIN_BATCH_SIZE) {
                claimed = await service.drain();
              }
            } while (rerun);
          } catch (error) {
            deps.log.warn("webhook outbox drain failed", { ...errorSummary(error) });
          } finally {
            running = false;
          }
        })();
      };
      service.setWakeup(tick);
      const poll = setInterval(tick, 2000);
      poll.unref();
      let pruning = false;
      const prune = setInterval(
        () => {
          if (pruning) return;
          pruning = true;
          void service
            .prune()
            .catch((error: unknown) => {
              deps.log.warn("webhook retention sweep failed", { ...errorSummary(error) });
            })
            .finally(() => {
              pruning = false;
            });
        },
        60 * 60 * 1000,
      );
      prune.unref();
    },
  };
}
