// The feature registry: the one place that lists every feature. main.ts and the contract
// generator use it. Add a new feature here.
import type { Database } from "../platform/db.ts";
import type { Feature } from "../platform/feature.ts";
import { createSystemFeature, systemRoutes } from "./system/index.ts";

export function createFeatures(database: Database): Feature[] {
  return [createSystemFeature({ ping: database.ping })];
}

// Every REST route definition, for contract/openapi.json.
export const routes = [...systemRoutes];
