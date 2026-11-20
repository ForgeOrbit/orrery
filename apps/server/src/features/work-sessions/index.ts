// Public interface of the work-sessions feature. Other code imports only this file.
import type { Feature } from "../../platform/feature.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { SessionReader } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { type SessionsDeps, type SessionsService, createSessionsService } from "./service.ts";
import { createSessionsMcp } from "./mcp.ts";
import { createSessionsRest, routes } from "./rest.ts";

export { routes as sessionsRoutes };
export { SessionsError } from "./service.ts";
export type { SessionsErrorKind, SessionsService } from "./service.ts";

export type SessionsFeatureDeps = SessionsDeps & {
  sessionReader: SessionReader;
  authenticate: AgentAuthenticator;
};

export interface SessionsFeature extends Feature {
  service: SessionsService;
  // The narrow seam projects borrows to fence agent issue edits and closure.
  agentHoldsSession(
    tx: DbTransaction,
    agentId: string,
    workspaceId: string,
    issueId: string,
  ): Promise<boolean>;
}

export function createSessionsFeature(deps: SessionsFeatureDeps): SessionsFeature {
  const service = createSessionsService({
    db: deps.db,
    projectAccessCeiling: deps.projectAccessCeiling,
    projectAccessAtLeast: deps.projectAccessAtLeast,
    listIssues: deps.listIssues,
    questionLeaseDeadline: deps.questionLeaseDeadline,
    evaluateQuestionDeadline: deps.evaluateQuestionDeadline,
  });
  return {
    name: "work-sessions",
    rest: createSessionsRest(service, deps.sessionReader, deps.authenticate),
    registerTools: createSessionsMcp(service, deps.authenticate),
    service,
    agentHoldsSession: (tx, agentId, workspaceId, issueId) =>
      service.agentHoldsSession(tx, agentId, workspaceId, issueId),
  };
}
