import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "./client.ts";

// Applies the plain .sql files in /db/migrations in file-name order, all in one transaction, so a
// failing migration leaves the database unchanged. Applied files are recorded in schema_migrations. An advisory lock makes this safe when several
// replicas start at once. Any implementation of the server can apply the same files.
const LOCK_ID = 4_206_917; // arbitrary, fixed: "orrery migrations"

export async function migrate(sql: Sql, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).toSorted();
  const applied: string[] = [];

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`;
    const done = new Set(
      (await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
    );

    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), "utf8");
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    }
  });

  return applied;
}
