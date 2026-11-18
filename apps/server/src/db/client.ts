import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Sql = postgres.Sql;

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  return { sql, db: drizzle(sql) };
}

export type Db = ReturnType<typeof createDb>["db"];
