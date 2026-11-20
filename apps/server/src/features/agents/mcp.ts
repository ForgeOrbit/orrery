import type { McpServer } from "@modelcontextprotocol/server";
import { tools } from "@orrery/contract";
import { ProjectsError, type ProjectsService, type WorkActor } from "../projects/index.ts";
import { AgentsError, type AgentsService } from "./service.ts";

// MCP transport adapter for agent project work (issue #33). Like rest.ts, this file only
// reads the credential from the transport, calls services, and maps the result. Every
// access decision belongs to agents/service.ts (does this key authenticate?) and
// projects/service.ts (may this actor do this on this project?). No membership, project
// access grant, workspace, or instance administration tool is registered here.

// Bearer parsing stays a transport detail, as in agents/rest.ts. The service decides
// whether a missing or invalid token authenticates.
function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  return /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? null;
}

type Args = Record<string, unknown>;
type Strategy = (actor: WorkActor, args: Args) => Promise<Record<string, unknown>>;

const text = (value: unknown, key: string): string => {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`missing ${key}`);
  }
  const found = Reflect.get(value, key);
  if (typeof found !== "string") throw new Error(`missing ${key}`);
  return found;
};

export function createAgentsMcp(service: AgentsService, projects: ProjectsService) {
  // One strategy per contract tool. The names are the contract's names, so an added tool
  // without a strategy is a build-time error rather than an unhandled tool call.
  const strategies: Record<string, Strategy> = {
    list_projects: async (actor, args) => ({
      projects: await projects.listProjects(actor, text(args, "workspaceId")),
    }),
    get_project: async (actor, args) => ({
      project: await projects.getProject(actor, text(args, "projectId")),
    }),
    list_issues: async (actor, args) => ({
      issues: await projects.listIssues(actor, text(args, "projectId")),
    }),
    get_issue: async (actor, args) => ({
      issue: await projects.getIssue(actor, text(args, "issueId")),
    }),
    create_issue: async (actor, args) => ({
      issue: await projects.createIssue(actor, text(args, "projectId"), {
        title: text(args, "title"),
        body: typeof args.body === "string" ? args.body : undefined,
      }),
    }),
    update_issue: async (actor, args) => ({
      issue: await projects.updateIssue(actor, text(args, "issueId"), {
        title: typeof args.title === "string" ? args.title : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
        status: args.status === "open" || args.status === "closed" ? args.status : undefined,
      }),
    }),
    list_comments: async (actor, args) => ({
      comments: await projects.listComments(actor, text(args, "issueId")),
    }),
    create_comment: async (actor, args) => ({
      comment: await projects.createComment(actor, text(args, "issueId"), {
        body: text(args, "body"),
      }),
    }),
    list_activity: async (actor, args) => ({
      activity: await projects.listActivity(actor, text(args, "projectId")),
    }),
    list_knowledge: async (actor, args) => ({
      entries: await projects.listKnowledge(actor, text(args, "projectId")),
    }),
    get_knowledge: async (actor, args) => ({
      entry: await projects.getKnowledge(actor, text(args, "entryId")),
    }),
    create_knowledge: async (actor, args) => ({
      entry: await projects.createKnowledge(actor, text(args, "projectId"), {
        title: text(args, "title"),
        body: typeof args.body === "string" ? args.body : undefined,
      }),
    }),
    update_knowledge: async (actor, args) => ({
      entry: await projects.updateKnowledge(actor, text(args, "entryId"), {
        title: typeof args.title === "string" ? args.title : undefined,
        body: typeof args.body === "string" ? args.body : undefined,
      }),
    }),
  };

  for (const tool of tools) {
    if (!(tool.name in strategies)) throw new Error(`no strategy for MCP tool ${tool.name}`);
  }

  return (server: McpServer, request: Request): void => {
    for (const tool of tools) {
      const strategy = strategies[tool.name];
      if (strategy === undefined) continue;
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          outputSchema: tool.output,
        },
        async (args: Args) => {
          try {
            // Authentication is re-run for every tool call, so revocation, expiry, a
            // removed membership, or a lowered human grant takes effect immediately.
            const identity = await service.authenticate(readBearer(request));
            const result = await strategy({ kind: "agent", identity }, args);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (error instanceof AgentsError || error instanceof ProjectsError) {
              const code = error.kind;
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify({ code, message: error.message }) },
                ],
                structuredContent: { code, message: error.message },
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
