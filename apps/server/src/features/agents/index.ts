// Public interface of the agents feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { ProjectsService } from "../projects/index.ts";
import { createAgentsMcp } from "./mcp.ts";
import { createAgentsRest, routes } from "./rest.ts";
import { type AgentsDeps, createAgentsService } from "./service.ts";

export { routes as agentsRoutes };
export type { AgentsService, AgentsError, AgentsErrorKind } from "./service.ts";

// Management routes borrow accounts' session reader; bearer-header parsing stays inside
// rest.ts, and the service alone decides whether a presented credential authenticates.
export function createAgentsFeature(
  deps: AgentsDeps & { sessionReader: SessionReader; projects: ProjectsService },
): Feature {
  const service = createAgentsService(deps);
  return {
    name: "agents",
    rest: createAgentsRest(service, deps.sessionReader),
    // The project-work tools authenticate a bearer key and call the projects service;
    // they are the only MCP surface an agent key can reach.
    registerTools: createAgentsMcp(service, deps.projects),
  };
}
