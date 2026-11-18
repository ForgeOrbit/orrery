import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unjournaledMigrations } from "./check-migrations.mjs";

test("lists .sql files missing from the drizzle-kit journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orrery-migrations-"));
  try {
    await mkdir(join(dir, "meta"));
    await writeFile(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({ entries: [{ idx: 0, tag: "0000_accounts" }] }),
    );
    await writeFile(join(dir, "0000_accounts.sql"), "select 1;");
    await writeFile(join(dir, "0001_by_hand.sql"), "select 1;");
    assert.deepEqual(await unjournaledMigrations(dir), ["0001_by_hand.sql"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("treats every .sql file as unjournaled when there is no journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orrery-migrations-"));
  try {
    await writeFile(join(dir, "0000_by_hand.sql"), "select 1;");
    assert.deepEqual(await unjournaledMigrations(dir), ["0000_by_hand.sql"]);
    await rm(join(dir, "0000_by_hand.sql"));
    assert.deepEqual(await unjournaledMigrations(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
