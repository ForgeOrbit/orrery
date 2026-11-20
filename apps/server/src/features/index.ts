// The feature registry: the one place that lists every feature. main.ts and the contract
// generator use it. Add a new feature here.
import type { Database } from "../platform/db.ts";
import type { Config } from "../platform/config.ts";
import type { Feature } from "../platform/feature.ts";
import type { Logger } from "../platform/log.ts";
import { createAccountsFeature, accountsRoutes } from "./accounts/index.ts";
import { createAgentsFeature, agentsRoutes } from "./agents/index.ts";
import { createInvitationsFeature, invitationsRoutes } from "./invitations/index.ts";
import { createProjectsFeature, projectsRoutes } from "./projects/index.ts";
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
  const projects = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
  });
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
      applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
        projects.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
      log,
    }),
    projects,
    // Agents borrow accounts' session reader for management and projects' one project
    // access resolver for the dynamic ceiling on a key. Its bearer reader is private to
    // its own identity route.
    createAgentsFeature({
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
];
