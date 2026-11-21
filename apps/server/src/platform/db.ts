import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Sql = postgres.Sql;

export type DbTransaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  return {
    sql,
    db: drizzle(sql),

    ping: async () => {
      await sql`select 1`;
    },
  };
}

export type Database = ReturnType<typeof createDb>;
