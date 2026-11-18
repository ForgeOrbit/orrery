import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Sql = postgres.Sql;

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
