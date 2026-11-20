import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentIdentity } from "@orrery/contract";
import {
  ClaimWorkSessionInput,
  GetWorkSessionInput,
  ReadyWorkInput,
  RenewWorkSessionInput,
  ReportProgressInput,
  StopWorkSessionInput,
  WorkSessionsListInput,
  sessionTools,
} from "@orrery/contract";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import { SessionsError, type SessionsService } from "./service.ts";

// MCP transport adapter for work sessions (#36). It authenticates the bearer key on every
// call, validates tool args with the shared contract schemas, calls the service, and maps
// failures to MCP structured errors. No policy or lease decision lives here.

type Args = Record<string, unknown>;

const str = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  return value;
};

export function createSessionsMcp(service: SessionsService, authenticate: AgentAuthenticator) {
  const strategies: Record<string, (identity: AgentIdentity, args: Args) => Promise<Args>> = {
    claim_issue: async (identity, args) => ({
      session: await service.claim(
        { kind: "agent", identity },
        { issueId: str(args.issueId, "issueId"), runId: str(args.runId, "runId") },
      ),
    }),
    renew_claim: async (identity, args) => ({
      session: await service.renew({ kind: "agent", identity }, str(args.issueId, "issueId")),
    }),
    report_progress: async (identity, args) => ({
      session: await service.progress(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
        str(args.summary, "summary"),
      ),
    }),
    stop_session: async (identity, args) => ({
      session: await service.stop(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
        args.outcome === "released" ? "released" : "completed",
      ),
    }),
    get_work_session: async (identity, args) => ({
      session: await service.getSession({ kind: "agent", identity }, str(args.issueId, "issueId")),
    }),
    list_work_sessions: async (identity, args) => ({
      sessions: await service.listSessions(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
      ),
    }),
    ready_work: async (identity, args) => ({
      issues: await service.readyWork(
        { kind: "agent", identity },
        str(args.projectId, "projectId"),
      ),
    }),
  };

  const parsers: Record<string, (value: unknown) => Args> = {
    claim_issue: (value) => ClaimWorkSessionInput.parse(value),
    renew_claim: (value) => RenewWorkSessionInput.parse(value),
    report_progress: (value) => ReportProgressInput.parse(value),
    stop_session: (value) => StopWorkSessionInput.parse(value),
    get_work_session: (value) => GetWorkSessionInput.parse(value),
    list_work_sessions: (value) => WorkSessionsListInput.parse(value),
    ready_work: (value) => ReadyWorkInput.parse(value),
  };

  for (const tool of sessionTools) {
    if (!(tool.name in strategies) || !(tool.name in parsers)) {
      throw new Error(`no strategy for MCP tool ${tool.name}`);
    }
  }

  return (server: McpServer, request: Request): void => {
    for (const tool of sessionTools) {
      const strategy = strategies[tool.name];
      const parse = parsers[tool.name];
      if (strategy === undefined || parse === undefined) continue;
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
            if (identity === null) throw new SessionsError("not_signed_in");
            const result = await strategy(identity, parse(rawArgs));
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (isAgentError(error) || error instanceof SessionsError) {
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
