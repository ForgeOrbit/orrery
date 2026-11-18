import { WorkspaceKind } from "@orrery/contract";
import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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

// A container that owns projects: one personal workspace per human, or a shared one.
// The allowed kinds come from the contract's WorkspaceKind enum.

// The kind of a human's own workspace, typed against the contract enum so code, types,
// and the database cannot drift apart.
export const personalKind: WorkspaceKind = "personal";

// A CHECK constraint is DDL: it cannot carry bound parameters, so the kind list must be
// raw SQL text. That is safe here because the values come from the WorkspaceKind enum,
// never from input.
const kindList = WorkspaceKind.options.map((kind) => `'${kind}'`).join(", ");

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
    check("workspace_kind", sql`${t.kind} in (${sql.raw(kindList)})`),
    // Exactly the personal kind carries a personal owner; the literal comes from the
    // enum value, raw for the same DDL reason as the kind list above.
    check(
      "workspace_owner_matches_kind",
      sql`(${t.kind} = ${sql.raw(`'${personalKind}'`)}) = (${t.personalOwnerHumanId} is not null)`,
    ),
    // One personal workspace per human; the literal comes from the enum value above.
    uniqueIndex("one_personal_workspace_per_human")
      .on(t.personalOwnerHumanId)
      .where(sql`${t.kind} = ${sql.raw(`'${personalKind}'`)}`),
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
