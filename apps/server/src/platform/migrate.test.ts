import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Sql } from "./db.ts";
import { migrate } from "./migrate.ts";

describe("migrate", () => {
  let pg: StartedPostgreSqlContainer;
  let sql: Sql;
  let dir: string;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    sql = createDb(pg.getConnectionUri()).sql;
    dir = await mkdtemp(join(tmpdir(), "orrery-migrations-"));
    await writeFile(
      join(dir, "0000_init.sql"),
      "create table a (id int primary key);\n--> statement-breakpoint\ncreate table b (id int primary key);\n",
    );
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
  });

  it("applies each file once, even when replicas start at the same time", async () => {
    const results = await Promise.all([migrate(sql, dir), migrate(sql, dir), migrate(sql, dir)]);
    expect(results.flat()).toEqual(["0000_init.sql"]);
    expect(await migrate(sql, dir)).toEqual([]);
    const tables =
      await sql`select tablename from pg_tables where tablename in ('a', 'b') order by 1`;
    expect(tables.map((t) => t.tablename)).toEqual(["a", "b"]);
  });

  it("rolls back every file when one fails", async () => {
    await writeFile(join(dir, "0001_ok.sql"), "create table c (id int);");
    await writeFile(join(dir, "0002_bad.sql"), "create table oops (;");
    await expect(migrate(sql, dir)).rejects.toThrow(/syntax error/);
    const [row] = await sql`select to_regclass('c') as c`;
    expect(row?.c).toBeNull();
  });
});
