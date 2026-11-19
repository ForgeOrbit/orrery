// Public interface of the accounts feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { AccountsService } from "./service.ts";
import { createAccountsRest, createSessionReader, routes, type SessionReader } from "./rest.ts";
import { type AccountsDeps, createAccountsService } from "./service.ts";

export { routes as accountsRoutes };
export { startupWarnings } from "./service.ts";
export type { AccountsService, SessionPolicy, SessionAccount } from "./service.ts";
export { createSessionReader, type SessionReader } from "./rest.ts";

// The accounts feature, plus what other features borrow: the session reader they
// authorize with, and the humans write one of their flows earns. The cookie stays this
// feature's transport detail; borrowers never learn its name.
export interface AccountsFeature extends Feature {
  sessionReader: SessionReader;
  markEmailVerified: AccountsService["markEmailVerified"];
}

export function createAccountsFeature(deps: AccountsDeps): AccountsFeature {
  const service = createAccountsService(deps);
  return {
    name: "accounts",
    rest: createAccountsRest(service),
    sessionReader: createSessionReader(service),
    markEmailVerified: (humanId, tx) => service.markEmailVerified(humanId, tx),
  };
}
