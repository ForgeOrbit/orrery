import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { Health } from "@orrery/contract";
import type { SystemService } from "./service.ts";

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

// Route definitions, for the generated OpenAPI document.
export const routes = [healthz, readyz];

// Thin: call the service, map the result to HTTP. No rules here.
export function createSystemRest(service: SystemService) {
  const app = new OpenAPIHono();
  app.openapi(healthz, (c) => c.json(service.health(), 200));
  app.openapi(readyz, async (c) => {
    const health = await service.ready();
    return health.status === "ok" ? c.json(health, 200) : c.json(health, 503);
  });
  return app;
}
