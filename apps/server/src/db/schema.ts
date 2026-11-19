import {
  InvitationDelivery,
  InvitationStatus,
  WorkspaceKind,
  SmtpSecurity,
} from "@orrery/contract";
import { sql } from "drizzle-orm";
import {
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

// Membership of a shared workspace (issue #24). The shape is deliberately small: a
// membership is a human's presence in the workspace, and `is_owner` carries the one
// role this slice grants. The capability columns from #28 extend this table without
// changing identity. Personal workspaces do not use memberships; their single owner is
// `workspaces.personal_owner_human_id`.
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

// The access-change events this slice records (issue #24): creating a workspace, joining
// by invitation, appointing or removing an owner, and removing an ordinary member.
// History visibility arrives in #32; the events are written now so it can be built on
// real history rather than a later backfill. Content never carries secrets.
export const workspaceEventTypes = [
  "workspace_created",
  "member_joined",
  "owner_appointed",
  "member_removed",
  "owner_removed",
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
