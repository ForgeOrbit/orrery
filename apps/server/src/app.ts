import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Services } from "./service/index.ts";
import { createMcpApp } from "./transport/mcp/index.ts";
import { createRestApp } from "./transport/rest/index.ts";

export interface AppOptions {
  services: Services;
  publicUrl: string;
  webDist?: string | undefined;
}

// One process serves the web app, the REST API and MCP.
export function createApp({ services, publicUrl, webDist }: AppOptions) {
  const app = new Hono();

  app.route("/", createRestApp(services));
  app.route("/mcp", createMcpApp(services, publicUrl));

  if (webDist) {
    app.use("/*", serveStatic({ root: webDist }));
    // Single-page app: unknown GET paths get index.html, and the client router takes over.
    const index = readFile(join(webDist, "index.html"), "utf8");
    app.get("*", async (c) => c.html(await index));
  }

  return app;
}
