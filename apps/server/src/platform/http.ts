import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Problem } from "@orrery/contract";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Feature } from "./feature.ts";
import { errorSummary } from "./errors.ts";
import type { Logger } from "./log.ts";
import { createMcpApp } from "./mcp.ts";

export interface AppOptions {
  features: readonly Feature[];
  publicUrl: string;
  log: Logger;
  webDist?: string | undefined;
}

// One process serves the web app, the REST API and MCP.
export function createApp({ features, publicUrl, log, webDist }: AppOptions) {
  const app = new Hono();

  // An unhandled error becomes one JSON log line and a 500 Problem. The line carries
  // the error summary (see errors.ts: name and code for database errors, name and
  // message for the rest), the method, and the path only: never parameters, headers,
  // cookies, or bodies.
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // Hono's own errors (for example a body that is not JSON) answer as a Problem too.
      if (error.res !== undefined) return error.getResponse();
      return c.json(Problem.parse({ message: error.message || "Bad request." }), error.status);
    }
    log.error("unhandled error", {
      ...errorSummary(error),
      method: c.req.method,
      path: c.req.path,
    });
    return c.json(Problem.parse({ message: "Internal server error." }), 500);
  });

  // Request logging logs the method and path only: never headers, cookies, query
  // strings, or bodies, so authorization headers, passwords, and token-bearing URLs
  // cannot reach the logs.
  app.use("*", async (c, next) => {
    await next();
    log.info("request", { method: c.req.method, path: c.req.path, status: c.res.status });
  });

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
