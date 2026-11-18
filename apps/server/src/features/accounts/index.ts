// Public interface of the accounts feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import { createAccountsRest, routes } from "./rest.ts";
import { type AccountsDeps, createAccountsService } from "./service.ts";

export { routes as accountsRoutes };
export type { AccountsService } from "./service.ts";

export interface AccountsFeatureDeps extends AccountsDeps {
  // The URL people use to reach the server. Its scheme decides whether the session
  // cookie is marked Secure.
  publicUrl: string;
}

export function createAccountsFeature({
  db,
  setupSecret,
  publicUrl,
}: AccountsFeatureDeps): Feature {
  const service = createAccountsService({ db, setupSecret });
  return {
    name: "accounts",
    rest: createAccountsRest(service, { secure: publicUrl.startsWith("https://") }),
  };
}
