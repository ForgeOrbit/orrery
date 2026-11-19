// Public interface of the accounts feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import { createAccountsRest, createSessionReader, routes, type SessionReader } from "./rest.ts";
import { type AccountsDeps, createAccountsService } from "./service.ts";

export { routes as accountsRoutes };
export { startupWarnings } from "./service.ts";
export type { AccountsService, SessionPolicy, SessionAccount } from "./service.ts";
export { createSessionReader, type SessionReader } from "./rest.ts";

// The accounts feature, plus the session reader other features authorize with. The
// cookie stays this feature's transport detail; borrowers never learn its name.
export interface AccountsFeature extends Feature {
  sessionReader: SessionReader;
}

export function createAccountsFeature(deps: AccountsDeps): AccountsFeature {
  const service = createAccountsService(deps);
  return {
    name: "accounts",
    rest: createAccountsRest(service),
    sessionReader: createSessionReader(service),
  };
}
