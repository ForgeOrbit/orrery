import type { Feature } from "../../platform/feature.ts";
import { createRecoveryRest, routes } from "./rest.ts";
import { type RecoveryDeps, createRecoveryService } from "./service.ts";

export { routes as recoveryRoutes };
export { createRecoveryService } from "./service.ts";
export { RecoveryError } from "./service.ts";
export type { RecoveryService, RecoveryAccountAccess, RecoveryDeps } from "./service.ts";

export interface RecoveryFeature extends Feature {}

export function createRecoveryFeature(deps: RecoveryDeps): RecoveryFeature {
  return {
    name: "recovery",
    rest: createRecoveryRest(createRecoveryService(deps)),
  };
}
