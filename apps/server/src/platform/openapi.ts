import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";

// The REST contract version, bumped by hand when the API changes. Not the build version.
const API_VERSION = "0.1.0";

// Builds the OpenAPI document from route definitions alone, without handlers or a database.
export function openApiDocument(routes: readonly RouteConfig[]) {
  const doc = new OpenAPIHono();
  for (const route of routes) doc.openAPIRegistry.registerPath(route);
  return doc.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Orrery API", version: API_VERSION },
  });
}
