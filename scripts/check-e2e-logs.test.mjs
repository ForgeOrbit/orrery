// Covers the log check's core: clean logs pass, a planted needle fails by line number
// without echoing the value, and a missing or empty needle file fails.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkLogs } from "./check-e2e-logs.mjs";

test("clean logs pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orrery-logcheck-"));
  try {
    const file = join(dir, "needles");
    await writeFile(file, "one-secret\nanother-secret\n");
    const result = await checkLogs({ logs: "nothing sensitive here", needlesFile: file });
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a planted needle fails by line number, never echoing the value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orrery-logcheck-"));
  try {
    const file = join(dir, "needles");
    await writeFile(file, "quiet-value\nloud-value\n");
    const result = await checkLogs({
      logs: "postgres DETAIL line says loud-value",
      needlesFile: file,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /lines 2\b/);
    assert.doesNotMatch(result.reason, /loud-value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing needle file fails", async () => {
  const result = await checkLogs({ logs: "anything", needlesFile: "/nonexistent/orrery-needles" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing/);
});

test("an empty needle file fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orrery-logcheck-"));
  try {
    const file = join(dir, "needles");
    await writeFile(file, "\n  \n");
    const result = await checkLogs({ logs: "anything", needlesFile: file });
    assert.equal(result.ok, false);
    assert.match(result.reason, /empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
