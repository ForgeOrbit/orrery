// Every REST route a feature mounts must also be in the exported `routes` list, or it is missing
// from contract/openapi.json. A route written as plain app.get/app.post (instead of createRoute and
// app.openapi) or left out of the list fails here.
import { expect, it } from "vitest";
import { loadConfig } from "../platform/config.ts";
import { createDb } from "../platform/db.ts";
import { createFeatures, routes } from "./index.ts";

// postgres.js connects lazily, so building the features never touches this address.
const config = loadConfig({ DATABASE_URL: "postgres://unused@127.0.0.1:1/unused" });
const database = createDb(config.DATABASE_URL);

const key = (method: string, path: string) =>
  `${method.toUpperCase()} ${path.replaceAll(/\{(\w+)\}/g, ":$1")}`;

it("lists every mounted REST route in the contract", async () => {
  const mounted = createFeatures(database, config)
    .flatMap((f) => f.rest?.routes ?? [])
    .filter((r) => r.method !== "ALL") // middleware, not an endpoint
    .map((r) => key(r.method, r.path));
  const documented = routes.map((r) => key(r.method, r.path));

  expect(new Set(mounted)).toEqual(new Set(documented));
  await database.sql.end();
});
