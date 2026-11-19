// Public interface of the accounts feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { AccountsService } from "./service.ts";
import { createAccountsRest, createSessionReader, routes, type SessionReader } from "./rest.ts";
import { type AccountsDeps, createAccountsService } from "./service.ts";

export { routes as accountsRoutes };
export { startupWarnings } from "./service.ts";
export type { AccountsService, SessionPolicy, SessionAccount } from "./service.ts";
export { createSessionReader, type SessionReader } from "./rest.ts";

// The accounts feature, plus what other features need from it: resolving the account
// behind a session cookie, marking an email verified inside another feature's
// transaction, creating an invited human with their personal workspace inside one
// (issue #23), and the registered-email guard. The cookie's name stays private to this
// feature.
export interface AccountsFeature extends Feature {
  sessionReader: SessionReader;
  markEmailVerified: AccountsService["markEmailVerified"];
  createInvitedHuman: AccountsService["createInvitedHuman"];
  emailRegistered: AccountsService["emailRegistered"];
}

export function createAccountsFeature(deps: AccountsDeps): AccountsFeature {
  const service = createAccountsService(deps);
  return {
    name: "accounts",
    rest: createAccountsRest(service),
    sessionReader: createSessionReader(service),
    markEmailVerified: (humanId, tx) => service.markEmailVerified(humanId, tx),
    createInvitedHuman: (input, tx) => service.createInvitedHuman(input, tx),
    emailRegistered: (email, tx) => service.emailRegistered(email, tx),
  };
}
