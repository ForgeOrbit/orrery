// The feature registry: the one place that lists every feature. main.ts and the contract
// generator use it. Add a new feature here.
import type { Database } from "../platform/db.ts";
import type { Config } from "../platform/config.ts";
import type { Feature } from "../platform/feature.ts";
import type { Logger } from "../platform/log.ts";
import { createLogger } from "../platform/log.ts";
import { createAccountsFeature, accountsRoutes } from "./accounts/index.ts";
import { createSettingsFeature, settingsRoutes } from "./settings/index.ts";
import { createSystemFeature, systemRoutes } from "./system/index.ts";

export function createFeatures(database: Database, config: Config, log?: Logger): Feature[] {
  const logger = log ?? createLogger("error");
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: config.BOOTSTRAP_SECRET,
    publicUrl: config.PUBLIC_URL,
  });
  return [
    createSystemFeature({ ping: database.ping }),
    accounts,
    // Settings authorizes with the accounts feature's session reader, so the session
    // cookie stays accounts' transport detail. Its service defaults to the real SMTP
    // transport; tests inject a fake.
    createSettingsFeature({
      db: database.db,
      publicUrl: config.PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      log: logger,
    }),
  ];
}

// Every REST route definition, for contract/openapi.json.
export const routes = [...systemRoutes, ...accountsRoutes, ...settingsRoutes];
