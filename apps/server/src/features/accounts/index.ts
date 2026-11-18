// Public interface of the accounts feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import { createAccountsRest, routes } from "./rest.ts";
import { type AccountsDeps, createAccountsService } from "./service.ts";

export { routes as accountsRoutes };
export { createAccountsService } from "./service.ts";
export type { AccountsService, SessionPolicy } from "./service.ts";

export function createAccountsFeature(deps: AccountsDeps): Feature {
  const service = createAccountsService(deps);
  return { name: "accounts", rest: createAccountsRest(service) };
}
