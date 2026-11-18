// Fails when db/migrations/ holds a .sql file that drizzle-kit didn't create. Every migration must be
// listed in drizzle-kit's journal (db/migrations/meta/_journal.json): run `pnpm db:generate`, or
// `pnpm db:generate --custom --name <what>` for SQL that Drizzle can't express.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function unjournaledMigrations(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql"));
  let entries = [];
  try {
    entries = JSON.parse(await readFile(join(dir, "meta", "_journal.json"), "utf8")).entries ?? [];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const journaled = new Set(entries.map((e) => `${e.tag}.sql`));
  return files.filter((f) => !journaled.has(f)).toSorted();
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "db/migrations";
  const stray = await unjournaledMigrations(dir);
  if (stray.length > 0) {
    console.error(`Not created by drizzle-kit (missing from ${dir}/meta/_journal.json):`);
    for (const f of stray) console.error(`  ${f}`);
    console.error(
      "Change apps/server/src/db/schema.ts and run 'pnpm db:generate' instead of writing SQL by hand.",
    );
    process.exit(1);
  }
}
