// Public interface of the projects feature. Other code imports only this file.
import type { ProjectAccessLevel } from "@orrery/contract";
import type { Feature } from "../../platform/feature.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import {
  type ProjectsDeps,
  type ProjectsService,
  type WorkSessionGate,
  createProjectsService,
} from "./service.ts";
import { createProjectsMcp } from "./mcp.ts";
import { createProjectsRest, routes } from "./rest.ts";

export { routes as projectsRoutes };
export { projectAccessAtLeast } from "./service.ts";
export { ProjectsError } from "./service.ts";
export type { ProjectsErrorKind, WorkActor, WorkSessionGate } from "./service.ts";

export type ProjectsDepsWithAccounts = ProjectsDeps & {
  sessionReader: SessionReader;
  // A narrow seam from the agents feature: both project adapters turn a request into
  // one WorkActor, so REST and MCP share the same authorization decisions.
  agentAuthenticator: AgentAuthenticator;
  // The work-sessions feature fences agent issue edits on a live session. Late-bound in
  // features/index.ts so the two features need not import each other.
  sessionGate: WorkSessionGate;
};

// The feature also exposes the access cleanup a workspace membership removal needs. It
// stays on the projects side because project grants and their events are its tables;
// workspaces calls it inside its own transaction.
export interface ProjectsFeature extends Feature {
  // The service is internal to this feature but exposed for same-project feature tests;
  // the type is deliberately not re-exported from this index.
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
    rest: createProjectsRest(service, deps.sessionReader, deps.agentAuthenticator),
    service,
    // The project-work tools belong to this feature: they call its own service and only
    // borrow an authenticator from agents, not the agents service itself.
    registerTools: createProjectsMcp(service, deps.agentAuthenticator),
    revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
      service.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
    applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
      service.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      service.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
  };
}
