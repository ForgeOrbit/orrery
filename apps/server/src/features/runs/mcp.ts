import type { McpServer } from "@modelcontextprotocol/server";
import { RunReportInput, runTools } from "@orrery/contract";
import { RunsError, type RunsService } from "./service.ts";

// MCP transport adapter for run reporting (issue #34). It validates the shared schema,
// passes the original request to the service — which re-authenticates the bearer key on
// every call — and maps the result. No policy lives here, and no lease is granted.

export function createRunsMcp(service: RunsService) {
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
            const parsed = RunReportInput.parse(rawArgs);
            const result = await service.report(request, parsed);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (error instanceof RunsError) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ code: error.kind, message: error.message }),
                  },
                ],
                structuredContent: { code: error.kind, message: error.message },
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
