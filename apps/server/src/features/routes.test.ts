import { PROBLEM_CONTENT_TYPE, Problem } from "@orrery/contract";
import { afterAll, expect, it } from "vitest";
import { loadConfig } from "../platform/config.ts";
import { createDb } from "../platform/db.ts";
import { createLogger } from "../platform/log.ts";
import { createFeatures, routes } from "./index.ts";

const config = loadConfig({ DATABASE_URL: "postgres://unused@127.0.0.1:1/unused" });
const database = createDb(config.DATABASE_URL);

const log = createLogger("error");
afterAll(async () => {
  await database.sql.end();
});

const key = (method: string, path: string) =>
  `${method.toUpperCase()} ${path.replaceAll(/\{(\w+)\}/g, ":$1")}`;

it("lists every mounted REST route in the contract", async () => {
  const mounted = createFeatures(database, config, log)
    .flatMap((f) => f.rest?.routes ?? [])
    .filter((r) => r.method !== "ALL")
    .map((r) => key(r.method, r.path));
  const documented = routes.map((r) => key(r.method, r.path));

  expect(new Set(mounted)).toEqual(new Set(documented));
});

it("declares every API error response as a Problem, and no success as one", () => {
  const wrong: string[] = [];
  for (const route of routes) {
    if (!route.path.startsWith("/api/")) continue;
    for (const [status, response] of Object.entries(route.responses)) {
      const content = "content" in response ? response.content : undefined;
      const types = Object.keys(content ?? {});
      const isError = Number(status) >= 400;
      const isProblem =
        types.length === 1 &&
        types[0] === PROBLEM_CONTENT_TYPE &&
        content?.[PROBLEM_CONTENT_TYPE]?.schema === Problem;
      if (isError !== isProblem) wrong.push(`${key(route.method, route.path)} ${status}`);
    }
  }
  expect(wrong).toEqual([]);
});
