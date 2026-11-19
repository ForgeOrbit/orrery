import { WorkspaceKind, SmtpSecurity } from "@orrery/contract";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
