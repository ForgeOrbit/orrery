import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { Services } from "../../service/index.ts";
import { version } from "../../version.ts";

// createMcpHonoApp's JSON middleware stores the parsed request body here, but its types don't say so.
declare module "hono" {
  interface ContextVariableMap {
    parsedBody: unknown;
  }
}

// Agents connect here over Streamable HTTP. Every tool in @orrery/contract's `tools` gets a
// handler that calls the service layer, so agents follow the same rules as people.
export function createMcpServer(_services: Services) {
  return new McpServer({ name: "orrery", version });
}

export function createMcpApp(services: Services, publicUrl: string) {
  // DNS rebinding protection: only PUBLIC_URL's host is accepted, in Host and in Origin (when sent).
  const hostname = new URL(publicUrl).hostname;
  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: [hostname],
    allowedOrigins: [hostname],
  });

  app.all("/", async (c) => {
    // Stateless for now: one server and transport per request.
    const server = createMcpServer(services);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, { parsedBody: c.get("parsedBody") });
  });

  return app;
}
