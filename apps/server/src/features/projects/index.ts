// Public interface of the projects feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type ProjectsDeps, createProjectsService } from "./service.ts";
import { createProjectsRest, routes } from "./rest.ts";

export { routes as projectsRoutes };
export type { ProjectsService } from "./service.ts";

export type ProjectsDepsWithAccounts = ProjectsDeps & { sessionReader: SessionReader };

// The feature also exposes the access cleanup a workspace membership removal needs. It
// stays on the projects side because project grants and their events are its tables;
// workspaces calls it inside its own transaction.
export interface ProjectsFeature extends Feature {
  revokeMemberProjectAccess(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
  ): Promise<void>;
}

export function createProjectsFeature(deps: ProjectsDepsWithAccounts): ProjectsFeature {
  const service = createProjectsService(deps);
  return {
    name: "projects",
    rest: createProjectsRest(service, deps.sessionReader),
    revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
      service.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
  };
}
