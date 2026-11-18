import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { Feature } from "./feature.ts";
import { version } from "./version.ts";

// createMcpHonoApp's JSON middleware stores the parsed request body here, but its types don't say so.
declare module "hono" {
  interface ContextVariableMap {
    parsedBody: unknown;
  }
}

// Agents connect here over Streamable HTTP. Each feature adds its tools (contracts in
// @orrery/contract), and the tools call the feature's service, so agents follow the same rules
// as people.
export function createMcpApp(features: readonly Feature[], publicUrl: string) {
  // DNS rebinding protection: only PUBLIC_URL's host is accepted, in Host and in Origin (when sent).
  const hostname = new URL(publicUrl).hostname;
  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: [hostname],
    allowedOrigins: [hostname],
  });

  app.all("/", async (c) => {
    // Stateless for now: one server and transport per request.
    const server = new McpServer({ name: "orrery", version });
    for (const feature of features) feature.registerTools?.(server);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: c.get("parsedBody") });
  });

  return app;
}
