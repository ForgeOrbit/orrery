import type { McpServer } from "@modelcontextprotocol/server";
import { projectTools } from "@orrery/contract";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import { ProjectsError, type ProjectsService, type WorkActor } from "./service.ts";

// MCP transport adapter for the projects feature (issue #33). Like rest.ts, this file only
// authenticates the request, validates tool input with the shared contract, calls this
// feature's own service, and maps the result. Every access decision is in service.ts.
// No membership, project access, workspace, or instance administration tool is registered.

type Args = Record<string, unknown>;
type Strategy = (actor: WorkActor, args: Args) => Promise<Args>;

// A typed accessor: the contract schema has already parsed and validated the argument.
const str = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  return value;
};

export function createProjectsMcp(service: ProjectsService, authenticate: AgentAuthenticator) {
  const strategies: Record<string, Strategy> = {
    list_projects: async (actor, args) => ({
      projects: await service.listProjects(actor, str(args.workspaceId, "workspaceId")),
    }),
    get_project: async (actor, args) => ({
      project: await service.getProject(actor, str(args.projectId, "projectId")),
    }),
    list_issues: async (actor, args) => ({
      issues: await service.listIssues(actor, str(args.projectId, "projectId")),
    }),
    get_issue: async (actor, args) => ({
      issue: await service.getIssue(actor, str(args.issueId, "issueId")),
    }),
    create_issue: async (actor, args) => ({
      issue: await service.createIssue(actor, str(args.projectId, "projectId"), {
        title: str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
      }),
    }),
    update_issue: async (actor, args) => ({
      issue: await service.updateIssue(actor, str(args.issueId, "issueId"), {
        title: args.title === undefined ? undefined : str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
        status: args.status === "open" || args.status === "closed" ? args.status : undefined,
      }),
    }),
    list_comments: async (actor, args) => ({
      comments: await service.listComments(actor, str(args.issueId, "issueId")),
    }),
    create_comment: async (actor, args) => ({
      comment: await service.createComment(actor, str(args.issueId, "issueId"), {
        body: str(args.body, "body"),
      }),
    }),
    list_activity: async (actor, args) => ({
      activity: await service.listActivity(actor, str(args.projectId, "projectId")),
    }),
    list_knowledge: async (actor, args) => ({
      entries: await service.listKnowledge(actor, str(args.projectId, "projectId")),
    }),
    get_knowledge: async (actor, args) => ({
      entry: await service.getKnowledge(actor, str(args.entryId, "entryId")),
    }),
    create_knowledge: async (actor, args) => ({
      entry: await service.createKnowledge(actor, str(args.projectId, "projectId"), {
        title: str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
      }),
    }),
    update_knowledge: async (actor, args) => ({
      entry: await service.updateKnowledge(actor, str(args.entryId, "entryId"), {
        title: args.title === undefined ? undefined : str(args.title, "title"),
        body: args.body === undefined ? undefined : str(args.body, "body"),
      }),
    }),
  };

  for (const tool of projectTools) {
    if (!(tool.name in strategies)) throw new Error(`no strategy for MCP tool ${tool.name}`);
  }

  return (server: McpServer, request: Request): void => {
    for (const tool of projectTools) {
      const strategy = strategies[tool.name];
      if (strategy === undefined) continue;
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          outputSchema: tool.output,
        },
        async (rawArgs) => {
          try {
            // Authentication is re-run for every tool call: revocation, expiry, a removed
            // membership, or a lowered human grant takes effect immediately. No bearer
            // header is an authentication failure here; MCP has no human session.
            const identity = await authenticate(request);
            if (identity === null) throw new ProjectsError("not_signed_in");
            const parsed = tool.input.parse(rawArgs);
            const result = await strategy(
              { kind: "agent", identity },
              Object.fromEntries(Object.entries(parsed)),
            );
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (isAgentError(error) || error instanceof ProjectsError) {
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
