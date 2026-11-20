// Public interface of the transfers feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createTransfersRest, routes } from "./rest.ts";
import { createTransfersService, type TransfersDeps, type TransfersService } from "./service.ts";

export { routes as transfersRoutes };
export { TransfersError } from "./service.ts";
export type { TransfersErrorKind } from "./service.ts";

export type TransfersDepsWithAccounts = TransfersDeps & {
  sessionReader: SessionReader;
};

export interface TransfersFeature extends Feature {
  service: TransfersService;
}

export function createTransfersFeature(deps: TransfersDepsWithAccounts): TransfersFeature {
  const service = createTransfersService(deps);
  return {
    name: "transfers",
    rest: createTransfersRest(service, deps.sessionReader),
    service,
  };
}
