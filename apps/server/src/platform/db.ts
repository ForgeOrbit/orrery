import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Sql = postgres.Sql;

// A database transaction, as the transaction callback receives it. Features pass it
// between themselves when one owns a table but another owns the flow (for example,
// accounts marks an email verified inside settings' redemption).
export type DbTransaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  return {
    sql,
    db: drizzle(sql),
    // Throws if the database can't be reached.
    ping: async () => {
      await sql`select 1`;
    },
  };
}

export type Database = ReturnType<typeof createDb>;
