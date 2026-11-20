// The feature registry: the one place that lists every feature. main.ts and the contract
// generator use it. Add a new feature here.
import type { Database } from "../platform/db.ts";
import type { Config } from "../platform/config.ts";
import type { Feature } from "../platform/feature.ts";
import type { Logger } from "../platform/log.ts";
import { createAccountsFeature, accountsRoutes } from "./accounts/index.ts";
import { createAgentsFeature, agentsRoutes, revokeMemberWorkspaceKeys } from "./agents/index.ts";
import type { AgentAuthenticator } from "./agents/index.ts";
import { createHistoryFeature, historyRoutes } from "./history/index.ts";
import { createInvitationsFeature, invitationsRoutes } from "./invitations/index.ts";
import { createProjectsFeature, projectAccessAtLeast, projectsRoutes } from "./projects/index.ts";
import { createSettingsFeature, settingsRoutes } from "./settings/index.ts";
import { createSystemFeature, systemRoutes } from "./system/index.ts";
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
  const projects = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator,
  });
  const agents = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projects.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
  });
  authenticateAgent = agents.authenticator;
  return [
    createSystemFeature({ ping: database.ping }),
    accounts,
    settings,
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
  ];
}

// Every REST route definition, for contract/openapi.json.
export const routes = [
  ...systemRoutes,
  ...accountsRoutes,
  ...agentsRoutes,
  ...settingsRoutes,
  ...invitationsRoutes,
  ...workspacesRoutes,
  ...projectsRoutes,
  ...historyRoutes,
];
