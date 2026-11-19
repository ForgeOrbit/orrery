// Public interface of the projects feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type ProjectsDeps, createProjectsService } from "./service.ts";
import { createProjectsRest, routes } from "./rest.ts";

export { routes as projectsRoutes };
export type { ProjectsService } from "./service.ts";

export type ProjectsDepsWithAccounts = ProjectsDeps & { sessionReader: SessionReader };

export function createProjectsFeature(deps: ProjectsDepsWithAccounts): Feature {
  const service = createProjectsService(deps);
  return { name: "projects", rest: createProjectsRest(service, deps.sessionReader) };
}
