import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Feature } from "./feature.ts";
import { createMcpApp } from "./mcp.ts";

export interface AppOptions {
  features: readonly Feature[];
  publicUrl: string;
  webDist?: string | undefined;
}

// One process serves the web app, the REST API and MCP.
export function createApp({ features, publicUrl, webDist }: AppOptions) {
  const app = new Hono();

  for (const feature of features) if (feature.rest) app.route("/", feature.rest);
  app.route("/mcp", createMcpApp(features, publicUrl));

  if (webDist) {
    app.use("/*", serveStatic({ root: webDist }));
    // Single-page app: unknown GET paths get index.html, and the client router takes over.
    const index = readFile(join(webDist, "index.html"), "utf8");
    app.get("*", async (c) => c.html(await index));
  }

  return app;
}
