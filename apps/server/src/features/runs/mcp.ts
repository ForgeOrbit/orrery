import type { McpServer } from "@modelcontextprotocol/server";
import { RunReportInput, runTools } from "@orrery/contract";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import { RunsError, type RunsService } from "./service.ts";

// MCP transport adapter for run reporting (issue #34). It authenticates the bearer key
// on every call, validates the shared schema, calls the service with the identity, and
// maps the result. No policy lives here, and no lease is granted.

export function createRunsMcp(service: RunsService, authenticate: AgentAuthenticator) {
  return (server: McpServer, request: Request): void => {
    for (const tool of runTools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          outputSchema: tool.output,
        },
        async (rawArgs) => {
          try {
            const identity = await authenticate(request);
            const parsed = RunReportInput.parse(rawArgs);
            const result = await service.report(identity, parsed);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            // A key revoked after the client connected is refused on the next call, with
            // the agents feature's own stable code — no service-local copy of its kinds.
            if (isAgentError(error) || error instanceof RunsError) {
              const code = error.kind;
              const message = error.message;
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }],
                structuredContent: { code, message },
                isError: true,
              };
            }
            throw error;
          }
        },
      );
    }
  };
}
