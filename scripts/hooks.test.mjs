import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("pre-commit stages files with both lint and formatting fixes applied", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "orrery-hooks-"));
  const run = (command, args) => execFileSync(command, args, { cwd: dir, encoding: "utf8" });
  try {
    for (const name of ["lefthook.yml", ".oxlintrc.json", ".oxfmtrc.json", "tsconfig.base.json"]) {
      await cp(join(root, name), join(dir, name));
    }
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { types: [] } }),
    );
    await writeFile(join(dir, "type.ts"), "export interface Thing { size: number; }\n");
    run("git", ["init", "-q"]);
    for (let i = 0; i < 100; i++) {
      await writeFile(
        join(dir, `test${i}.ts`),
        'import { Thing } from "./type.ts";\nexport const f=(s:Thing)=>{return s.size};\n',
      );
    }
    run("git", ["add", "."]);
    run(join(root, "node_modules/.bin/lefthook"), ["run", "pre-commit", "--force"]);
    const expected =
      'import type { Thing } from "./type.ts";\nexport const f = (s: Thing) => {\n  return s.size;\n};\n';
    for (let i = 0; i < 100; i++) {
      assert.equal(run("git", ["show", `:test${i}.ts`]), expected);
    }
    assert.equal(run("git", ["diff", "--name-only"]), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
