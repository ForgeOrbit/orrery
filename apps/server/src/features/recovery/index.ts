// Public interface of the recovery feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import { createRecoveryRest, routes } from "./rest.ts";
import { type RecoveryDeps, type RecoveryService, createRecoveryService } from "./service.ts";

export { routes as recoveryRoutes };
export { createRecoveryService } from "./service.ts";
export { RecoveryError } from "./service.ts";
export type { RecoveryService, RecoveryAccountAccess, RecoveryDeps } from "./service.ts";

// Password recovery is its own feature: it borrows accounts' credential seams and
// settings' one mail sender. Nothing here can reopen bootstrap or change a workspace.
export interface RecoveryFeature extends Feature {
  localRecover: RecoveryService["localRecover"];
}

export function createRecoveryFeature(deps: RecoveryDeps): RecoveryFeature {
  const service = createRecoveryService(deps);
  return {
    name: "recovery",
    rest: createRecoveryRest(service),
    localRecover: (email, password) => service.localRecover(email, password),
  };
}
