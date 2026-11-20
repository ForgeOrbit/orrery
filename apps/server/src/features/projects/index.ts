// Public interface of the projects feature. Other code imports only this file.
import type { ProjectAccessLevel } from "@orrery/contract";
import type { Feature } from "../../platform/feature.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionReader } from "../accounts/index.ts";
import { type ProjectsDeps, type ProjectsService, createProjectsService } from "./service.ts";
import { createProjectsRest, routes } from "./rest.ts";

export { routes as projectsRoutes };
export { projectAccessAtLeast } from "./service.ts";
export { ProjectsError } from "./service.ts";
export type { ProjectsErrorKind, ProjectsService, WorkActor } from "./service.ts";

export type ProjectsDepsWithAccounts = ProjectsDeps & { sessionReader: SessionReader };

// The feature also exposes the access cleanup a workspace membership removal needs. It
// stays on the projects side because project grants and their events are its tables;
// workspaces calls it inside its own transaction.
export interface ProjectsFeature extends Feature {
  // The service itself, borrowed by the agents feature so its MCP tools call the same
  // project-work decisions as the REST adapters.
  service: ProjectsService;
  revokeMemberProjectAccess(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
  ): Promise<void>;
  applyInvitationGrants(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    grantedByHumanId: string,
    offered: readonly { projectId: string; level: ProjectAccessLevel }[],
  ): Promise<string[]>;
  // The agent-key ceiling: the human's current access to named projects. Agents borrow
  // this so project levels are decided by one resolver for humans and agents alike.
  projectAccessCeiling(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    projectIds: readonly string[],
  ): Promise<Map<string, ProjectAccessLevel | null>>;
}

export function createProjectsFeature(deps: ProjectsDepsWithAccounts): ProjectsFeature {
  const service = createProjectsService(deps);
  return {
    name: "projects",
    rest: createProjectsRest(service, deps.sessionReader),
    service,
    revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
      service.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
    applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
      service.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      service.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
  };
}
