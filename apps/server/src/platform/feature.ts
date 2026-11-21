import type { OpenAPIHono } from "@hono/zod-openapi";
import type { McpServer } from "@modelcontextprotocol/server";

// What a feature hands the platform. Each feature's index.ts exports a factory that returns one;
// features/index.ts lists them all. The platform never imports a feature directly.
export interface Feature {
  name: string;
  // REST routes, mounted at the root. Route paths are absolute, for example /api/v1/issues.
  rest?: OpenAPIHono;
  // Adds the feature's MCP tools to a server. Called once per MCP request. The request is
  // passed in so a tool adapter can read its Authorization header; the platform never
  // interprets credentials or imports a feature to do it.
  registerTools?: (server: McpServer, request: Request) => void;
  // An optional recurring maintenance task (for example #98's 30-day trash sweep). The
  // platform starts it once at boot; the feature owns the work and its error handling.
  startBackgroundTasks?: () => void;
}
