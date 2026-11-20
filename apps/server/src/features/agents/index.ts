// Public interface of the agents feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { createAgentsRest, routes } from "./rest.ts";
import { type AgentsDeps, createAgentsService } from "./service.ts";

export { routes as agentsRoutes };
export { createAgentKeyReader, type AgentKeyReader } from "./rest.ts";
export type { AgentsService, AgentsError, AgentsErrorKind } from "./service.ts";

export type AgentsDepsWithAccounts = AgentsDeps & { sessionReader: SessionReader };

export function createAgentsFeature(deps: AgentsDepsWithAccounts): Feature {
  const service = createAgentsService(deps);
  return { name: "agents", rest: createAgentsRest(service, deps.sessionReader) };
}
