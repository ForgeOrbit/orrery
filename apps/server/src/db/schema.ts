import {
  AgentKeyEventType,
  AgentKeyValidity,
  InvitationDelivery,
  InvitationStatus,
  IssueLinkKind,
  IssueStatus,
  ProjectAccessEventType,
  ProjectAccessLevel,
  ProjectActivityType,
  QuestionStatus,
  RunStatus,
  TransferAuthorizationStatus,
  WorkSessionStatus,
  WorkspaceKind,
  SmtpSecurity,
} from "@orrery/contract";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// The database schema, in one place. drizzle-kit writes it to plain SQL in /db/migrations
// (see drizzle.config.ts); the server applies those files in name order at startup.

// A human account. Email normalization (trim, then lowercase) is defined once, in the
// shared contract's Email schema, and enforced here so no writer can store an
// un-normalized address. `email_verified_at` stays null until the mailbox is verified;
// bootstrap never requires SMTP (ADR-0001).
export const humans = pgTable(
  "humans",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isSystemAdministrator: boolean("is_system_administrator").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Account deactivation (#38). A non-null timestamp means the identity is suspended
    // across the installation: login, sessions, and agent keys stop, but the row (and
    // everything attributed to it) stays. Reactivation clears this same timestamp; it
    // never restores shared authority or old credentials.
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [check("humans_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`)],
);

// A list of values as quoted SQL literals, for a CHECK constraint over a text column
// backed by a contract enum. Raw SQL by necessity (DDL has no parameters); safe because
// the values are enum members, never input.
function sqlLiteralList(enumeration: { options: readonly string[] }): string {
  return enumeration.options.map((value) => `'${value}'`).join(", ");
}

// A container that owns projects: one personal workspace per human, or a shared one.
// The allowed kinds come from the contract's WorkspaceKind enum.

// A CHECK constraint is DDL: it cannot carry bound parameters, so the kind list must be
// raw SQL text. That is safe here because the values come from the WorkspaceKind enum,
// never from input.
const personalKindSql = sql.raw(`'${WorkspaceKind.enum.personal}'`);

// The invitations partial index needs the same trick: the pending literal comes from the
// InvitationStatus enum value, raw because DDL binds no parameters.
const pendingStatusSql = sql.raw(`'${InvitationStatus.enum.pending}'`);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<WorkspaceKind>().notNull(),
    name: text("name").notNull(),
    personalOwnerHumanId: text("personal_owner_human_id").references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workspace_kind", sql`${t.kind} in (${sql.raw(sqlLiteralList(WorkspaceKind))})`),
    // Exactly the personal kind carries a personal owner; the literal comes from the
    // enum value, raw for the same DDL reason as the kind list above.
    check(
      "workspace_owner_matches_kind",
      sql`(${t.kind} = ${personalKindSql}) = (${t.personalOwnerHumanId} is not null)`,
    ),
    // One personal workspace per human.
    uniqueIndex("one_personal_workspace_per_human")
      .on(t.personalOwnerHumanId)
      .where(sql`${t.kind} = ${personalKindSql}`),
  ],
);

// Per-workspace serialization point for ownership changes. Every supported writer
// updates this row before touching memberships, so a transaction with a stale snapshot
// fails serialization instead of committing a workspace with no owner. The row is
// created by a trigger with its workspace and removed with it.
export const workspaceOwnershipGuards = pgTable("workspace_ownership_guards", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(0),
});

// Membership of a shared workspace (issue #24). A membership is a human's presence in
// the workspace; `is_owner` carries full authority and the four `can_*` columns are the
// independently delegated workspace capabilities (#20, #28). They are all false by
// default, so membership alone never grants workspace-wide authority. Personal workspaces
// do not use memberships; their single owner is `workspaces.personal_owner_human_id`.
export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    isOwner: boolean("is_owner").notNull().default(false),
    canCreateProjects: boolean("can_create_projects").notNull().default(false),
    canInviteMembers: boolean("can_invite_members").notNull().default(false),
    canRemoveMembers: boolean("can_remove_members").notNull().default(false),
    canManageMemberPermissions: boolean("can_manage_member_permissions").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // A suspended membership (#38) grants no shared access. Deactivation suspends in
    // place rather than deleting, so it keeps the human's place in the workspace's history.
    // Re-inviting a reactivated human clears this and issues fresh grants.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    // Ownership held at suspension time, kept so a workspace whose only owner was
    // deactivated is eligible for later ownership recovery (#43) without ever restoring
    // ownership automatically on reactivation.
    isFormerOwner: boolean("is_former_owner").notNull().default(false),
  },
  (t) => [
    // One membership per person per workspace: accepting twice cannot double access.
    uniqueIndex("one_membership_per_workspace_and_human").on(t.workspaceId, t.humanId),
    // The listing starts from the caller's memberships.
    index("workspace_memberships_human_id").on(t.humanId),
  ],
);

// A workspace invitation (issue #24). It reuses the invitation lifecycle from #23 —
// pending, accepted, or expired in place, with delivery tracked separately — but targets
// a shared workspace instead of the installation. The emailed link carries a random
// token; only its SHA-256 hash is stored. Expiry is seven days, evaluated in database
// time when the token is redeemed.
export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // Normalized by the contract's Email schema; the CHECK enforces it for every writer.
    email: text("email").notNull(),
    status: text("status").$type<InvitationStatus>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByHumanId: text("invited_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deliveryStatus: text("delivery_status").$type<InvitationDelivery>(),
    deliveryAttemptedAt: timestamp("delivery_attempted_at", { withTimezone: true }),
  },
  (t) => [
    check("workspace_invitations_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),
    check(
      "workspace_invitations_status",
      sql`${t.status} in (${sql.raw(sqlLiteralList(InvitationStatus))})`,
    ),
    check(
      "workspace_invitations_delivery_status",
      sql`(${t.deliveryStatus} is null or ${t.deliveryStatus} in (${sql.raw(
        sqlLiteralList(InvitationDelivery),
      )}))`,
    ),
    // One pending invitation per address per workspace; the same person can be invited
    // to a different workspace without the links colliding.
    uniqueIndex("one_pending_workspace_invitation_per_email")
      .on(t.workspaceId, t.email)
      .where(sql`${t.status} = ${pendingStatusSql}`),
  ],
);

// The workspace access-change events recorded so far: #24's creation, joining,
// appointment, and removal, plus #27's Create projects grants and #28's other three
// capability grants. Project-level grants live in project_access_events below, because
// they are scoped to a project. History visibility arrives in #32; the events are written
// now so it can be built on real history rather than a later backfill. Content never
// carries secrets.
export const workspaceEventTypes = [
  "workspace_created",
  "member_joined",
  "owner_appointed",
  "member_removed",
  "owner_removed",
  // #37: voluntary leave is a distinct audit act from being removed by someone else.
  "member_left",
  "owner_left",
  "create_projects_granted",
  "create_projects_revoked",
  "invite_members_granted",
  "invite_members_revoked",
  "remove_members_granted",
  "remove_members_revoked",
  "manage_member_permissions_granted",
  "manage_member_permissions_revoked",
  // Personal-to-shared transfer (#39): the source records authorization and completion,
  // the destination its receipt. Workspace-scoped so each side keeps only its own audit.
  "project_transfer_authorized",
  "project_transfer_received",
  "project_transferred_out",
] as const;
export type WorkspaceEventType = (typeof workspaceEventTypes)[number];

export const workspaceEvents = pgTable(
  "workspace_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    type: text("type").$type<WorkspaceEventType>().notNull(),
    // The human who performed the action, and the human it concerned. They are the same
    // for a join or a workspace creation; different for an appointment or removal.
    actorHumanId: text("actor_human_id")
      .notNull()
      .references(() => humans.id),
    subjectHumanId: text("subject_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workspace_event_type",
      sql`${t.type} in (${sql.raw(workspaceEventTypes.map((value) => `'${value}'`).join(", "))})`,
    ),
    index("workspace_events_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

// A browser session. Only the SHA-256 hash of the cookie's token is stored.
export const browserSessions = pgTable("browser_sessions", {
  id: text("id").primaryKey(),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Bootstrap closes exactly once. The only allowed row is (true), inserted in the same
// transaction as the administrator; concurrent setups race on the primary key and
// exactly one can ever win (issue #21).
export const instanceSetup = pgTable(
  "instance_setup",
  {
    id: boolean("id").primaryKey(),
    administratorHumanId: text("administrator_human_id")
      .notNull()
      .references(() => humans.id),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_setup_singleton", sql`${t.id} = true`)],
);

// Persistent instance settings (ADR-0001): what the system administrator configures
// through the app, unlike deployment essentials, which come from environment variables.
// SMTP is one singleton row, written wholesale by an administrator. The password is the
// one secret in it, and it is never plaintext at rest: ADR-0004 encrypts it with the
// deployment's key, and only the ciphertext is stored.
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: boolean("id").primaryKey(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecurity: text("smtp_security").$type<SmtpSecurity>().notNull(),
    smtpUsername: text("smtp_username"),
    smtpPasswordEncrypted: text("smtp_password_encrypted"),
    smtpFrom: text("smtp_from").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByHumanId: text("updated_by_human_id")
      .notNull()
      .references(() => humans.id),
  },
  (t) => [
    check("instance_settings_singleton", sql`${t.id} = true`),
    // DDL cannot bind parameters, so the security list is raw SQL text; the values come
    // from the SmtpSecurity contract enum, never from input.
    check(
      "instance_settings_smtp_security",
      sql`${t.smtpSecurity} in (${sql.raw(sqlLiteralList(SmtpSecurity))})`,
    ),
  ],
);

// A single-use email verification token (issue #22). The email carries the raw token;
// only its SHA-256 hash is stored. Redemption is one conditional update in database
// time: unused, unexpired, and issued to the redeeming account.
export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

// A single-use password reset token (issue #31). The emailed link carries the raw
// token; only its SHA-256 hash is stored. Redemption is one conditional update in
// database time: unused, unexpired. A token is never issued to an unverified address,
// and a failed delivery removes its token so an email that never left cannot redeem.
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

// Recovery and password-reset events (#20 history): a reset was requested and mailed,
// a reset link was redeemed, or an administrator used the local recovery command.
// There is deliberately no token, hash, or password column — not even a snapshot of
// one — so reading this history can never expose a credential. The flow that earns
// each event writes it in the same transaction as the change it describes.
export const accountRecoveryEventTypes = [
  "password_reset_requested",
  "password_reset_completed",
  "local_recovery_completed",
  // #38: installation-wide account status changes. `humanId` is the affected account;
  // `actorHumanId` is the administrator who made the change. Secret-free by design.
  "account_deactivated",
  "account_reactivated",
] as const;
export type AccountRecoveryEventType = (typeof accountRecoveryEventTypes)[number];

export const accountRecoveryEvents = pgTable(
  "account_recovery_events",
  {
    id: text("id").primaryKey(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    // Null for password-recovery events, whose subject is also the actor. Set for the
    // deactivation/reactivation events (#38), recorded by a system administrator.
    actorHumanId: text("actor_human_id").references(() => humans.id),
    type: text("type").$type<AccountRecoveryEventType>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "account_recovery_events_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList({ options: accountRecoveryEventTypes }))})`,
    ),
    index("account_recovery_events_human_created").on(t.humanId, t.createdAt),
  ],
);

// An invitation (issue #23): a system administrator's offer to register on the
// installation, sent to one email. The emailed link carries a random token; only its
// SHA-256 hash is stored. The lifecycle is tracked separately from delivery and account
// verification (#20): the row keeps who invited and when it was accepted, expiry is
// seven days evaluated in database time at redemption, and a newer invitation supersedes
// a stale one in place by marking it expired.
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    // The invited address, normalized by the contract's Email schema; the CHECK enforces
    // it for every other writer, exactly like humans.
    email: text("email").notNull(),
    status: text("status").$type<InvitationStatus>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByHumanId: text("invited_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Delivery, tracked separately from the lifecycle: pending never implies delivered
    // (#20). Null means no attempt has been recorded; only 'failed' never redeems, and
    // an old null row is superseded once its send could no longer be in flight.
    deliveryStatus: text("delivery_status").$type<InvitationDelivery>(),
    deliveryAttemptedAt: timestamp("delivery_attempted_at", { withTimezone: true }),
  },
  (t) => [
    check("invitations_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),
    // DDL cannot bind parameters, so the status lists are raw SQL text; the values come
    // from the contract enums, never from input.
    check("invitations_status", sql`${t.status} in (${sql.raw(sqlLiteralList(InvitationStatus))})`),
    check(
      "invitations_delivery_status",
      sql`(${t.deliveryStatus} is null or ${t.deliveryStatus} in (${sql.raw(
        sqlLiteralList(InvitationDelivery),
      )}))`,
    ),
    // One pending invitation per email: a second valid link must not accumulate (#25
    // rotates the existing one instead).
    uniqueIndex("one_pending_invitation_per_email")
      .on(t.email)
      .where(sql`${t.status} = ${pendingStatusSql}`),
  ],
);

// A project (issue #26): a collection of issues and knowledge owned by one workspace.
// The creator is recorded as authorship, not as a second owner: the project belongs to
// the workspace. `next_issue_number` is the per-project counter that gives issues their
// human-readable numbers; it is incremented under the row lock of an issue creation.
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    createdByHumanId: text("created_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nextIssueNumber: integer("next_issue_number").notNull().default(1),
  },
  (t) => [
    check("projects_next_issue_number_positive", sql`${t.nextIssueNumber} > 0`),
    index("projects_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

// A source owner's authorization to move a personal project into a shared workspace
// (#39). The token is shown once and only its hash is stored, like an invitation. A
// receiver accepts while the authorization is pending and before its database-time
// expiry; acceptance rechecks every authority in one transaction and consumes the row.
export const projectTransferAuthorizations = pgTable(
  "project_transfer_authorizations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceWorkspaceId: text("source_workspace_id")
      .notNull()
      .references(() => workspaces.id),
    destinationWorkspaceId: text("destination_workspace_id")
      .notNull()
      .references(() => workspaces.id),
    authorizedByHumanId: text("authorized_by_human_id")
      .notNull()
      .references(() => humans.id),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").$type<TransferAuthorizationStatus>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "project_transfer_authorizations_status",
      sql`${t.status} in (${sql.raw(sqlLiteralList(TransferAuthorizationStatus))})`,
    ),
    check(
      "project_transfer_authorizations_sides_differ",
      sql`${t.sourceWorkspaceId} <> ${t.destinationWorkspaceId}`,
    ),
    index("project_transfer_authorizations_project").on(t.projectId),
  ],
);

// An explicit project access grant (issue #27). Personal projects have no direct
// collaborators; a trigger in migration 0012 refuses grants outside a shared workspace
// and grants to humans who are not members of that workspace. The workspace owner's
// Manage is implicit and has no row. The unique pair makes one level per person per
// project, and the CHECK keeps the level in the contract enum.
export const projectAccessGrants = pgTable(
  "project_access_grants",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    level: text("level").$type<ProjectAccessLevel>().notNull(),
    grantedByHumanId: text("granted_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One level per person per project: a change updates in place and cannot double.
    uniqueIndex("one_project_access_grant_per_human").on(t.projectId, t.humanId),
    // DDL cannot bind parameters; the values come from the ProjectAccessLevel enum.
    check(
      "project_access_grants_level",
      sql`${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))})`,
    ),
    index("project_access_grants_human_id").on(t.humanId),
  ],
);

// The projects an invitation offers (#25). The invitation belongs to one workspace, so
// every offered project must still belong to that same workspace when the offer is
// accepted. The level is the project access granted on acceptance; membership itself
// still grants no project access. Resending copies these rows to the replacement
// invitation, which keeps the offer and its history intact.
export const workspaceInvitationGrants = pgTable(
  "workspace_invitation_grants",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => workspaceInvitations.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    level: text("level").$type<ProjectAccessLevel>().notNull(),
  },
  (t) => [
    uniqueIndex("one_invitation_grant_per_project").on(t.invitationId, t.projectId),
    check(
      "workspace_invitation_grants_level",
      sql`${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))})`,
    ),
  ],
);

// Project access-change events (#27), scoped to the project whose access changed. The
// type implies the shape: a grant has a level and no previous level, a level change has
// both, and a revocation has only the previous level. #32 builds the history view on
// these rows; writing starts here, with no backfill. No emails or secrets are stored.
export const projectAccessEvents = pgTable(
  "project_access_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    actorHumanId: text("actor_human_id")
      .notNull()
      .references(() => humans.id),
    subjectHumanId: text("subject_human_id")
      .notNull()
      .references(() => humans.id),
    type: text("type").$type<ProjectAccessEventType>().notNull(),
    level: text("level").$type<ProjectAccessLevel>(),
    previousLevel: text("previous_level").$type<ProjectAccessLevel>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "project_access_events_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList(ProjectAccessEventType))})`,
    ),
    check(
      "project_access_events_level",
      sql`(${t.level} is null or ${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))}))`,
    ),
    check(
      "project_access_events_previous_level",
      sql`(${t.previousLevel} is null or ${t.previousLevel} in (${sql.raw(
        sqlLiteralList(ProjectAccessLevel),
      )}))`,
    ),
    // DDL cannot bind parameters; the event types are raw SQL text from the enum.
    check(
      "project_access_events_shape",
      sql`(
        (${t.type} = ${sql.raw(`'${ProjectAccessEventType.enum.project_access_granted}'`)}
          and ${t.level} is not null and ${t.previousLevel} is null)
        or (${t.type} = ${sql.raw(`'${ProjectAccessEventType.enum.project_access_level_changed}'`)}
          and ${t.level} is not null and ${t.previousLevel} is not null)
        or (${t.type} = ${sql.raw(`'${ProjectAccessEventType.enum.project_access_revoked}'`)}
          and ${t.level} is null and ${t.previousLevel} is not null)
      )`,
    ),
    index("project_access_events_project_created").on(t.projectId, t.createdAt),
  ],
);

// An agent is a worker identity owned by one human (issue #30). Its actions are
// attributed to this identity, not to a model or a run; several keys and clients can
// act as the same agent. Only the owner may register an agent under their identity.
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // An owner cannot create two agents under the same display name.
    uniqueIndex("one_agent_name_per_human").on(t.humanId, t.name),
    index("agents_human_created").on(t.humanId, t.createdAt),
  ],
);

// A bearer key for one agent, scoped to exactly one workspace (issue #30). The secret
// is shown once at issue time; only its SHA-256 hash is stored. A null `expires_at` is
// "Never" — it skips the time check, never the access checks. Revocation is a timestamp
// rather than a delete, so creation and revocation stay auditable.
export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdByHumanId: text("created_by_human_id")
      .notNull()
      .references(() => humans.id),
    validity: text("validity").$type<AgentKeyValidity>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByHumanId: text("revoked_by_human_id").references(() => humans.id),
    // Rotation lineage (#35): a replacement names the key it replaces. Ids only, never a
    // secret. SET NULL keeps a historical replacement valid if a source key is deleted.
    replacesKeyId: text("replaces_key_id").references((): AnyPgColumn => agentApiKeys.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    // DDL cannot bind parameters; the values come from the contract enum.
    check(
      "agent_api_keys_validity",
      sql`${t.validity} in (${sql.raw(sqlLiteralList(AgentKeyValidity))})`,
    ),
    index("agent_api_keys_workspace_created").on(t.workspaceId, t.createdAt),
    index("agent_api_keys_agent_created").on(t.agentId, t.createdAt),
  ],
);

// The selected projects a key may act on, with the requested level. A key can hold
// several projects in its one workspace; no row means the key has no project access.
export const agentApiKeyProjects = pgTable(
  "agent_api_key_projects",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => agentApiKeys.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    level: text("level").$type<ProjectAccessLevel>().notNull(),
  },
  (t) => [
    uniqueIndex("one_agent_key_project_per_project").on(t.keyId, t.projectId),
    check(
      "agent_api_key_projects_level",
      sql`${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))})`,
    ),
  ],
);

// Credential audit events (#20 history): creation and revocation of a key, with the
// actor and the workspace it happened in. There is deliberately no secret column — nor
// even a hash — so an audit read can never expose a credential. A workspace owner's
// revocation of someone else's key is recorded with that owner as the actor.
export const agentKeyEvents = pgTable(
  "agent_key_events",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => agentApiKeys.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    type: text("type").$type<AgentKeyEventType>().notNull(),
    actorHumanId: text("actor_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "agent_key_events_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList(AgentKeyEventType))})`,
    ),
    index("agent_key_events_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

// A run is one harness conversation under one agent identity (issue #34). The bearer
// key identifies the agent and scopes the workspace; the harness's native session id
// distinguishes concurrent conversations and survives a resume. Reported fields that a
// harness did not provide stay null so the UI can say `unknown` instead of inventing a
// value. A partial unique index enforces identity only when both harness and native
// session id were reported: two anonymous runs stay distinct instead of colliding on a
// sentinel, while two clients sharing one key's session id still get one row.
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    harness: text("harness"),
    harnessVersion: text("harness_version"),
    nativeSessionId: text("native_session_id"),
    model: text("model"),
    status: text("status").$type<RunStatus>().notNull().default(RunStatus.enum.active),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  },
  (t) => [
    check("runs_status", sql`${t.status} in (${sql.raw(sqlLiteralList(RunStatus))})`),
    uniqueIndex("one_run_per_agent_workspace_harness_session")
      .on(t.agentId, t.workspaceId, t.harness, t.nativeSessionId)
      .where(sql`${t.harness} is not null and ${t.nativeSessionId} is not null`),
    index("runs_workspace_created").on(t.workspaceId, t.createdAt),
    index("runs_agent_created").on(t.agentId, t.createdAt),
  ],
);

// Model values observed during a run. A change is written only when a reporter names a
// model different from the current one; an absent model never overwrites a known one.
export const runModelChanges = pgTable(
  "run_model_changes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    fromModel: text("from_model"),
    toModel: text("to_model").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("run_model_changes_run_created").on(t.runId, t.createdAt)],
);

// A child worker observed inside a parent run. Codex and Claude report child
// attribution in hooks on the parent's session; repeated events update this row in
// place when an identity was reported. Every attribution field is nullable, so an
// unreported one displays `unknown`, and two anonymous children stay distinct. A named
// child run must belong to the same agent and workspace (checked in the service) and is
// linked here by a foreign key that clears the link if that run is ever deleted.
export const runChildren = pgTable(
  "run_children",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    agentType: text("agent_type"),
    childRunId: text("child_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    status: text("status").$type<RunStatus>().notNull().default(RunStatus.enum.active),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    check("run_children_status", sql`${t.status} in (${sql.raw(sqlLiteralList(RunStatus))})`),
    // Only a named child has a stable identity. Two children with neither an agent id
    // nor a child run id are anonymous observations: both rows are kept, not collapsed.
    uniqueIndex("one_child_per_run_and_reported_identity")
      .on(t.runId, t.agentId, t.agentType, t.childRunId)
      .where(sql`${t.agentId} is not null or ${t.childRunId} is not null`),
    index("run_children_run_started").on(t.runId, t.startedAt),
  ],
);

// An issue in a project. The body is Markdown, stored as written. `number` is local to
// the project; the id is the stable identity. `closed_at` is set exactly while the issue
// is closed, so reopening clears it and an edit while closed leaves it untouched.
export const issues = pgTable(
  "issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").$type<IssueStatus>().notNull(),
    // Authorship is one identity, never two: a human or an agent, recorded in its own
    // column. An agent's work is attributed to the agent, not to its human owner.
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    updatedByHumanId: text("updated_by_human_id").references(() => humans.id),
    updatedByAgentId: text("updated_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Needs input is an issue state owned by the later human-input slice (#37). The flag
    // exists now so ready-work can exclude paused issues; no other writer sets it yet.
    needsInput: boolean("needs_input").notNull().default(false),
  },
  (t) => [
    // Exactly one author/editor identity: a human or an agent.
    check(
      "issues_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    check(
      "issues_updated_by_actor",
      sql`(${t.updatedByHumanId} is not null) <> (${t.updatedByAgentId} is not null)`,
    ),
    // Issue numbers never repeat inside a project, and two concurrent creations cannot
    // both take the same one.
    uniqueIndex("one_issue_number_per_project").on(t.projectId, t.number),
    check("issues_number_positive", sql`${t.number} > 0`),
    // DDL cannot bind parameters; the values come from the IssueStatus contract enum.
    check("issues_status", sql`${t.status} in (${sql.raw(sqlLiteralList(IssueStatus))})`),
    check(
      "issues_closed_at_matches_status",
      sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`,
    ),
  ],
);

// A comment on an issue. Comments are ordinary discussion: they need no work session
// (#20), and they keep the author who wrote them.
export const issueComments = pgTable(
  "issue_comments",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    body: text("body").notNull(),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "issue_comments_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    index("issue_comments_issue_created").on(t.issueId, t.createdAt),
  ],
);

// A structured external link attached to an issue (#87). The kind classifies the artifact
// so agents and humans can attach PRs and commits without burying URLs in Markdown. The
// author is one identity, human or agent, kept after either leaves. Like every data rule,
// the URL scheme and the (issue, url) uniqueness are enforced here too, not only in the
// contract, so no writer can store an unsafe or duplicated link.
export const issueLinks = pgTable(
  "issue_links",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    url: text("url").notNull(),
    title: text("title").notNull(),
    kind: text("kind").$type<IssueLinkKind>().notNull(),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "issue_links_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    check("issue_links_kind", sql`${t.kind} in (${sql.raw(sqlLiteralList(IssueLinkKind))})`),
    // DDL binds no parameters; the pattern is a fixed literal, never input.
    check("issue_links_url_http_s", sql`${t.url} ~* '^https?://'`),
    uniqueIndex("one_link_per_issue_and_url").on(t.issueId, t.url),
    index("issue_links_issue_created").on(t.issueId, t.createdAt),
  ],
);

// A work session: one attempt to work on one issue, coordinated within a run (#36). Its
// identity is (agent, run, workspace, issue) — never the API key used to reach it — so a
// replacement key during rotation renews the same session. The lease is a five-minute
// reservation evaluated in database time. `progress` is deliberately a separate column
// from the lease status: lazy expiry only flips `status`, so an interruption never erases
// what the worker recorded. The partial unique index is the database guarantee that two
// concurrent claims cannot both hold one issue, even if two transactions race past the
// row lock path.
export const workSessions = pgTable(
  "work_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    status: text("status")
      .$type<WorkSessionStatus>()
      .notNull()
      .default(WorkSessionStatus.enum.active),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    progress: text("progress").notNull().default(""),
    progressUpdatedAt: timestamp("progress_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "work_sessions_status",
      sql`${t.status} in (${sql.raw(sqlLiteralList(WorkSessionStatus))})`,
    ),
    // At most one active session per issue, enforced by Postgres under a concurrent race.
    uniqueIndex("one_active_work_session_per_issue")
      .on(t.issueId)
      .where(sql`${t.status} = ${sql.raw(`'${WorkSessionStatus.enum.active}'`)}`),
    index("work_sessions_agent_created").on(t.agentId, t.createdAt),
    index("work_sessions_run_created").on(t.runId, t.createdAt),
    index("work_sessions_issue_created").on(t.issueId, t.createdAt),
  ],
);

// A question an agent asked the team (issue #41). Its identity is the work session that
// asked it, never the API key used to reach the service, so key rotation keeps the same
// question history. The one-hour response deadline and every resolution are evaluated in
// database time; the partial unique index guarantees one open-or-paused question per issue,
// which is what keeps issues.needs_input unambiguous under concurrent asks.
export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => workSessions.id),
    question: text("question").notNull(),
    proposedFallback: text("proposed_fallback").notNull(),
    status: text("status").$type<QuestionStatus>().notNull().default("open"),
    responseDeadlineAt: timestamp("response_deadline_at", { withTimezone: true }).notNull(),
    answer: text("answer"),
    answeredByHumanId: text("answered_by_human_id").references(() => humans.id),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    followUp: text("follow_up"),
    followUpByHumanId: text("follow_up_by_human_id").references(() => humans.id),
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("questions_status", sql`${t.status} in (${sql.raw(sqlLiteralList(QuestionStatus))})`),
    check("questions_deadline_after_creation", sql`${t.responseDeadlineAt} > ${t.createdAt}`),
    // Exactly one resolution shape per status. `fallback_used` (#42) may carry a follow-up
    // answer, but it never clears that resolution or reverses the fallback work.
    check(
      "questions_resolution_matches_status",
      sql`(
        (${t.status} = 'open' and ${t.answer} is null and ${t.answeredByHumanId} is null
          and ${t.answeredAt} is null and ${t.resolvedAt} is null
          and ${t.followUp} is null and ${t.followUpByHumanId} is null and ${t.followUpAt} is null)
        or (${t.status} = 'answered' and ${t.answer} is not null and ${t.answeredByHumanId} is not null
          and ${t.answeredAt} is not null and ${t.resolvedAt} is not null
          and ${t.followUp} is null and ${t.followUpByHumanId} is null and ${t.followUpAt} is null)
        or (${t.status} in ('paused', 'fallback_used') and ${t.answer} is null
          and ${t.answeredByHumanId} is null and ${t.answeredAt} is null and ${t.resolvedAt} is not null
          and ((${t.followUp} is null and ${t.followUpByHumanId} is null and ${t.followUpAt} is null)
            or (${t.followUp} is not null and ${t.followUpByHumanId} is not null and ${t.followUpAt} is not null)))
      )`,
    ),
    // One active question per issue, so needs_input has a single owner at any moment.
    uniqueIndex("one_open_question_per_issue")
      .on(t.issueId)
      .where(sql`${t.status} in ('open', 'paused')`),
    index("questions_issue_created").on(t.issueId, t.createdAt),
    index("questions_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

// A basic Markdown knowledge entry (issue #26). This is deliberately not the full vault
// (#6): a title, a body, and who created and last edited it.
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    updatedByHumanId: text("updated_by_human_id").references(() => humans.id),
    updatedByAgentId: text("updated_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "knowledge_entries_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    check(
      "knowledge_entries_updated_by_actor",
      sql`(${t.updatedByHumanId} is not null) <> (${t.updatedByAgentId} is not null)`,
    ),
    index("knowledge_entries_project_created").on(t.projectId, t.createdAt),
  ],
);

// The project's activity feed (issue #26). Each event is written in the same transaction
// as the change it describes, so history cannot disagree with the project. The summary is
// a snapshot of the item's title at that moment, not a pointer that changes later.
//
// The target columns follow the event type: a project event points at neither item, an
// issue event points at the issue, and a knowledge event points at the entry. These
// literals come from the ProjectActivityType enum, never from input; DDL cannot bind
// parameters, so they are raw SQL text.
const projectActivityTypesSql = sql.raw(
  [ProjectActivityType.enum.project_created, ProjectActivityType.enum.project_renamed]
    .map((type) => `'${type}'`)
    .join(", "),
);
const issueActivityTypesSql = sql.raw(
  ProjectActivityType.options
    .filter((type) => type.startsWith("issue_"))
    .map((type) => `'${type}'`)
    .join(", "),
);
const knowledgeActivityTypesSql = sql.raw(
  ProjectActivityType.options
    .filter((type) => type.startsWith("knowledge_"))
    .map((type) => `'${type}'`)
    .join(", "),
);

export const projectActivity = pgTable(
  "project_activity",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type").$type<ProjectActivityType>().notNull(),
    // The actor is a human or an agent; both stay attached after either leaves.
    actorHumanId: text("actor_human_id").references(() => humans.id),
    actorAgentId: text("actor_agent_id").references(() => agents.id),
    issueId: text("issue_id").references(() => issues.id),
    knowledgeEntryId: text("knowledge_entry_id").references(() => knowledgeEntries.id),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one actor identity: a human or an agent.
    check(
      "project_activity_actor",
      sql`(${t.actorHumanId} is not null) <> (${t.actorAgentId} is not null)`,
    ),
    // DDL cannot bind parameters; the values come from the ProjectActivityType enum.
    check(
      "project_activity_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList(ProjectActivityType))})`,
    ),
    check(
      "project_activity_target_matches_type",
      sql`(
        (${t.type} in (${projectActivityTypesSql}) and ${t.issueId} is null and ${t.knowledgeEntryId} is null)
        or (${t.type} in (${issueActivityTypesSql}) and ${t.issueId} is not null and ${t.knowledgeEntryId} is null)
        or (${t.type} in (${knowledgeActivityTypesSql}) and ${t.issueId} is null and ${t.knowledgeEntryId} is not null)
      )`,
    ),
    index("project_activity_project_created").on(t.projectId, t.createdAt),
  ],
);
