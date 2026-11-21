import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type WorkspacesDeps, createWorkspacesService } from "./service.ts";
import { createWorkspacesRest, routes } from "./rest.ts";

export { routes as workspacesRoutes };
export type { WorkspacesService } from "./service.ts";

export type WorkspacesDepsWithAccounts = WorkspacesDeps & { sessionReader: SessionReader };

export function createWorkspacesFeature(deps: WorkspacesDepsWithAccounts): Feature {
  const service = createWorkspacesService(deps);
  return { name: "workspaces", rest: createWorkspacesRest(service, deps.sessionReader) };
}
