import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type DeactivationDeps, createDeactivationService } from "./service.ts";
import { createDeactivationRest, routes } from "./rest.ts";

export { routes as deactivationRoutes };
export { DeactivationError, createDeactivationService } from "./service.ts";
export type { DeactivationErrorKind, DeactivationService } from "./service.ts";

export type DeactivationDepsWithAccounts = DeactivationDeps & { sessionReader: SessionReader };

export function createDeactivationFeature(deps: DeactivationDepsWithAccounts): Feature {
  const service = createDeactivationService(deps);
  return { name: "deactivation", rest: createDeactivationRest(service, deps.sessionReader) };
}
