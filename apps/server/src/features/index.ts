// The feature registry: the one place that lists every feature. main.ts and the contract
// generator use it. Add a new feature here.
import type { Database } from "../platform/db.ts";
import type { Config } from "../platform/config.ts";
import type { Feature } from "../platform/feature.ts";
import { createAccountsFeature, accountsRoutes } from "./accounts/index.ts";
import { createSystemFeature, systemRoutes } from "./system/index.ts";

export function createFeatures(database: Database, config: Config): Feature[] {
  return [
    createSystemFeature({ ping: database.ping }),
    createAccountsFeature({
      db: database.db,
      setupSecret: config.BOOTSTRAP_SECRET,
      publicUrl: config.PUBLIC_URL,
    }),
  ];
}

// Every REST route definition, for contract/openapi.json.
export const routes = [...systemRoutes, ...accountsRoutes];
