import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Health } from "@orrery/contract";
import type { Services } from "../../service/index.ts";
// The REST contract version, bumped by hand when the API changes. Not the build version.
const API_VERSION = "0.1.0";

const healthz = createRoute({
  method: "get",
  path: "/healthz",
  summary: "Liveness: the process is up",
  responses: {
    200: { description: "Alive", content: { "application/json": { schema: Health } } },
  },
});

const readyz = createRoute({
  method: "get",
  path: "/readyz",
  summary: "Readiness: the database is reachable",
  responses: {
    200: { description: "Ready", content: { "application/json": { schema: Health } } },
    503: { description: "Not ready", content: { "application/json": { schema: Health } } },
  },
});

const routes = [healthz, readyz];

export function createRestApp(services: Services) {
  const app = new OpenAPIHono();

  app.openapi(healthz, (c) => c.json(services.system.health(), 200));
  app.openapi(readyz, async (c) => {
    const health = await services.system.ready();
    return health.status === "ok" ? c.json(health, 200) : c.json(health, 503);
  });

  return app;
}

// Builds the OpenAPI document from the route definitions alone, without handlers or services.
export function openApiDocument() {
  const doc = new OpenAPIHono();
  for (const route of routes) doc.openAPIRegistry.registerPath(route);
  return doc.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Orrery API", version: API_VERSION },
  });
}
