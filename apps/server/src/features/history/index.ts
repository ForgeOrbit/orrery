// Public interface of the history feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type HistoryDeps, createHistoryService } from "./service.ts";
import { createHistoryRest, routes } from "./rest.ts";

export { routes as historyRoutes };
export { HistoryError, createHistoryService } from "./service.ts";
export type { HistoryErrorKind, HistoryService } from "./service.ts";

export type HistoryDepsWithAccounts = HistoryDeps & { sessionReader: SessionReader };

export function createHistoryFeature(deps: HistoryDepsWithAccounts): Feature {
  const service = createHistoryService(deps);
  return { name: "history", rest: createHistoryRest(service, deps.sessionReader) };
}
