import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type OwnershipDeps, createOwnershipService } from "./service.ts";
import { createOwnershipRest, routes } from "./rest.ts";

export { routes as ownershipRoutes };
export { OwnershipError, createOwnershipService } from "./service.ts";
export type { OwnershipErrorKind, OwnershipService } from "./service.ts";

export type OwnershipDepsWithAccounts = OwnershipDeps & { sessionReader: SessionReader };

export function createOwnershipFeature(deps: OwnershipDepsWithAccounts): Feature {
  const service = createOwnershipService(deps);
  return { name: "ownership", rest: createOwnershipRest(service, deps.sessionReader) };
}
