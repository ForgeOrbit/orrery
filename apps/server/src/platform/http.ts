import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Problem } from "@orrery/contract";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Feature } from "./feature.ts";
import type { Logger } from "./log.ts";
import { createMcpApp } from "./mcp.ts";

export interface AppOptions {
  features: readonly Feature[];
  publicUrl: string;
  log: Logger;
  webDist?: string | undefined;
}

// Drizzle's error wrapper embeds the query and its parameters in its message, so log the
// deepest error instead: its name and message only, never params, headers, or bodies.
function rootError(error: unknown): { name: string; message: string } {
  let current = error instanceof Error ? error : undefined;
  while (current?.cause instanceof Error) current = current.cause;
  if (current === undefined) return { name: typeof error, message: String(error) };
  return { name: current.name, message: current.message };
}

// One process serves the web app, the REST API and MCP.
export function createApp({ features, publicUrl, log, webDist }: AppOptions) {
  const app = new Hono();

  // An unhandled error becomes one JSON log line and a 500 Problem. The line carries
  // the root error's name and message, the method, and the path only: never parameters,
  // headers, cookies, or bodies. HTTPException keeps its own response.
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const root = rootError(error);
    log.error("unhandled error", {
      error: root.name,
      message: root.message,
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
