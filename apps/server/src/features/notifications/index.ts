import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createNotificationsRest, routes } from "./rest.ts";
import {
  type NotificationsDeps,
  type NotificationsService,
  type NotifyActivity,
  createNotificationsService,
} from "./service.ts";

export { routes as notificationsRoutes };
export { NotificationsError } from "./service.ts";
export type {
  ActivityNotificationInput,
  NotificationsErrorKind,
  NotificationsService,
  NotifyActivity,
} from "./service.ts";

export type NotificationsFeatureDeps = NotificationsDeps & {
  sessionReader: SessionReader;
};

export interface NotificationsFeature extends Feature {
  service: NotificationsService;
  notifyActivity: NotifyActivity;
}

export function createNotificationsFeature(deps: NotificationsFeatureDeps): NotificationsFeature {
  const service = createNotificationsService(deps);
  return {
    name: "notifications",
    rest: createNotificationsRest(service, deps.sessionReader),
    service,
    notifyActivity: service.createForActivity,
    startBackgroundTasks: () => {
      const timer = setInterval(
        () => {
          void service.prune().catch((error: unknown) => {
            deps.log.warn("notification retention sweep failed", { error: String(error) });
          });
        },
        60 * 60 * 1000,
      );
      timer.unref();
    },
  };
}
