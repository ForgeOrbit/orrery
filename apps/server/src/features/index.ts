// The feature registry: the one place that lists every feature. main.ts and the contract
// generator use it. Add a new feature here.
import type { Database, DbTransaction } from "../platform/db.ts";
import type { Config } from "../platform/config.ts";
import type { Feature } from "../platform/feature.ts";
import type { Logger } from "../platform/log.ts";
import { createAccountsFeature, accountsRoutes } from "./accounts/index.ts";
import { createAgentsFeature, agentsRoutes, revokeMemberWorkspaceKeys } from "./agents/index.ts";
import type { AgentAuthenticator } from "./agents/index.ts";
import type { WorkSessionGate } from "./projects/index.ts";
import { createHistoryFeature, historyRoutes } from "./history/index.ts";
import { createInboxFeature, inboxRoutes } from "./inbox/index.ts";
import { createInvitationsFeature, invitationsRoutes } from "./invitations/index.ts";
import { createProjectsFeature, projectAccessAtLeast, projectsRoutes } from "./projects/index.ts";
import { createRecoveryFeature, recoveryRoutes } from "./recovery/index.ts";
import { createRunsFeature, runsRoutes } from "./runs/index.ts";
import { createSettingsFeature, settingsRoutes } from "./settings/index.ts";
import { createSystemFeature, systemRoutes } from "./system/index.ts";
import { createTransfersFeature, transfersRoutes } from "./transfers/index.ts";
import { createSessionsFeature, sessionsRoutes } from "./work-sessions/index.ts";
import { createWorkspacesFeature, workspacesRoutes } from "./workspaces/index.ts";

export function createFeatures(database: Database, config: Config, log: Logger): Feature[] {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: config.BOOTSTRAP_SECRET,
    publicUrl: config.PUBLIC_URL,
  });
  // Settings authorizes with the accounts feature's session reader and earns its
  // humans write, so the cookie and that table stay accounts' details. Its service
  // defaults to the real SMTP transport; tests inject a fake.
  const settings = createSettingsFeature({
    db: database.db,
    publicUrl: config.PUBLIC_URL,
    encryptionKey: config.ORRERY_ENCRYPTION_KEY,
    sessionReader: accounts.sessionReader,
    markEmailVerified: accounts.markEmailVerified,
    log,
  });
  // Projects owns project grants and their access events. Workspaces borrows the
  // removal cleanup so losing a membership ends project access in the same transaction.
  // Agents own key authentication; projects borrows only that narrow seam. The reference
  // is filled once the agents feature is built, so neither feature imports the other's
  // service at construction time.
  let authenticateAgent: AgentAuthenticator | undefined;
  const agentAuthenticator: AgentAuthenticator = (request) => {
    if (authenticateAgent === undefined) throw new Error("agent authenticator is not wired");
    return authenticateAgent(request);
  };
  // Projects fences agent issue edits through a late-bound seam; work sessions borrows
  // projects' one access resolver. Neither feature imports the other's service.
  let sessionGate: WorkSessionGate | undefined;
  const workSessionGate: WorkSessionGate = (tx, agentId, workspaceId, issueId) => {
    if (sessionGate === undefined) throw new Error("work session gate is not wired");
    return sessionGate(tx, agentId, workspaceId, issueId);
  };
  // Work sessions borrow the question deadline and the atomic deadline evaluation from
  // the inbox feature on its already issue-locked transaction, so a check-in cannot renew a
  // claim past the one-hour deadline. Both seams are filled once the inbox is built.
  let questionLeaseDeadline:
    | ((tx: DbTransaction, issueId: string) => Promise<Date | null>)
    | undefined;
  let questionEvaluateDeadline: ((tx: DbTransaction, issueId: string) => Promise<void>) | undefined;
  const leaseDeadline = (tx: DbTransaction, issueId: string): Promise<Date | null> => {
    if (questionLeaseDeadline === undefined) throw new Error("question deadline is not wired");
    return questionLeaseDeadline(tx, issueId);
  };
  const evaluateDeadline = (tx: DbTransaction, issueId: string): Promise<void> => {
    if (questionEvaluateDeadline === undefined) throw new Error("question deadline is not wired");
    return questionEvaluateDeadline(tx, issueId);
  };
  const projects = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator,
    sessionGate: workSessionGate,
    // A policy change freezes already-due questions through the same inbox seam a
    // check-in uses; the closure is live by the time any request reaches a policy route.
    evaluateQuestionDeadline: evaluateDeadline,
  });
  const agents = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
  });
  authenticateAgent = agents.authenticator;
  // Work sessions shares the agents authenticator and projects' access resolver; it is
  // built after both so its gate is live before any request can reach a fenced write.
  const sessions = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    listIssues: (actor, projectId) => projects.service.listIssues(actor, projectId),
    questionLeaseDeadline: leaseDeadline,
    evaluateQuestionDeadline: evaluateDeadline,
  });
  sessionGate = (tx, agentId, workspaceId, issueId) =>
    sessions.agentHoldsSession(tx, agentId, workspaceId, issueId);
  // The inbox is built after work sessions (it reuses the same agent session gate) and
  // fills the two deadline seams the sessions service calls on its locked transaction.
  const inbox = createInboxFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentAuthenticator,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    deliver: settings.deliver,
    log,
  });
  questionLeaseDeadline = (tx, issueId) => inbox.questionDeadline(tx, issueId);
  questionEvaluateDeadline = (tx, issueId) => inbox.evaluateDeadline(tx, issueId);
  return [
    createSystemFeature({ ping: database.ping }),
    accounts,
    settings,
    // Recovery borrows accounts' credential seams and settings' one mail sender. The
    // local command uses the same service, so its policy cannot drift from the HTTP flow.
    createRecoveryFeature({
      db: database.db,
      accounts: {
        accountByEmail: (email, tx) => accounts.accountByEmail(email, tx),
        setPassword: (humanId, password, tx) => accounts.setPassword(humanId, password, tx),
        invalidateBrowserSessions: (humanId, tx) => accounts.invalidateBrowserSessions(humanId, tx),
      },
      deliver: settings.deliver,
      publicUrl: config.PUBLIC_URL,
      log,
    }),
    // Invitations borrows the same things from accounts (the reader, the
    // registered-email guard, the account-creation seam, the verified mark) and sends
    // mail only through settings' exported sender, so no second mail path exists.
    createInvitationsFeature({
      db: database.db,
      publicUrl: config.PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      emailRegistered: accounts.emailRegistered,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log,
    }),
    createWorkspacesFeature({
      db: database.db,
      publicUrl: config.PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
        projects.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
      revokeMemberWorkspaceKeys: (tx, workspaceId, humanId, actorHumanId) =>
        revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId),
      releaseMemberWorkSessions: (tx, workspaceId, humanId) =>
        sessions.releaseMemberWorkSessions(tx, workspaceId, humanId),
      applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
        projects.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
      log,
    }),
    projects,
    agents,
    // History borrows only projects' access resolver; it never imports another feature's
    // service, and its routes use accounts' human session reader, never an agent key.
    createHistoryFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
        projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    }),
    // Run reporting borrows the same authenticator; the agents feature is built above,
    // so the late-bound seam is live by the time any MCP tool or hook is called.
    createRunsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      authenticate: agentAuthenticator,
    }),
    sessions,
    inbox,
    // Transfer rechecks source and destination authority in one transaction. It borrows
    // only the human session reader; no agent key or MCP tool performs an ownership move.
    createTransfersFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
    }),
  ];
}

// Every REST route definition, for contract/openapi.json.
export const routes = [
  ...systemRoutes,
  ...accountsRoutes,
  ...agentsRoutes,
  ...settingsRoutes,
  ...recoveryRoutes,
  ...invitationsRoutes,
  ...workspacesRoutes,
  ...projectsRoutes,
  ...historyRoutes,
  ...runsRoutes,
  ...sessionsRoutes,
  ...inboxRoutes,
  ...transfersRoutes,
];
