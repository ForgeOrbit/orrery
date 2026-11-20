// Public interface of the recovery feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import { createRecoveryRest, routes } from "./rest.ts";
import { type RecoveryDeps, createRecoveryService } from "./service.ts";

export { routes as recoveryRoutes };
export { createRecoveryService } from "./service.ts";
export { RecoveryError } from "./service.ts";
export type { RecoveryService, RecoveryAccountAccess, RecoveryDeps } from "./service.ts";

// Password recovery is its own feature: it borrows accounts' credential seams and
// settings' one mail sender. The local command builds the service directly, so no
// extra feature-facing method is needed; nothing here can reopen bootstrap or change
// a workspace.
export interface RecoveryFeature extends Feature {}

export function createRecoveryFeature(deps: RecoveryDeps): RecoveryFeature {
  return {
    name: "recovery",
    rest: createRecoveryRest(createRecoveryService(deps)),
  };
}
