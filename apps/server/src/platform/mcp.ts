import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { Feature } from "./feature.ts";
import { version } from "./version.ts";

declare module "hono" {
  interface ContextVariableMap {
    parsedBody: unknown;
  }
}

export function createMcpApp(features: readonly Feature[], publicUrl: string) {
  const hostname = new URL(publicUrl).hostname;
  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: [hostname],
    allowedOrigins: [hostname],
  });

  app.all("/", async (c) => {
    const server = new McpServer({ name: "orrery", version });
    for (const feature of features) feature.registerTools?.(server, c.req.raw);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: c.get("parsedBody") });
  });

  return app;
}
