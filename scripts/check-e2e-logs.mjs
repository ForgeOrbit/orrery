// Fails when the running stack's logs contain a secret value they must never contain:
// the bootstrap secret, passwords, session cookies, or a stored password hash (Postgres
// "Failing row contains (…)" DETAIL lines carry the hash). The needles live in one
// per-run file (tests/e2e/.secrets-used) that the e2e suites append every secret they
// use or receive to, so the check covers the real values, not hand-made copies. Fails
// when that file is missing or empty: no needles, no check.
//
//   node scripts/check-e2e-logs.mjs [needles-file]
//
// Never prints a needle's value: on failure it reports the needle file's line numbers.
//
// The e2e tests stay language-neutral, so the one server-specific needle lives here: the
// prefix of the stored password hash. Update it if the server changes its hash format.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// The 1-based line numbers (in the needles file) whose values appear in the logs.
export function leakedNeedleLines(logs, needles) {
  const lines = [];
  for (const [index, needle] of needles.entries()) {
    if (needle.length > 0 && logs.includes(needle)) lines.push(index + 1);
  }
  return lines;
}

export const SERVER_NEEDLES = ["scrypt$"];

function readNeedles(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function checkLogs({ logs, needlesFile }) {
  let text;
  try {
    text = await readFile(needlesFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { ok: false, reason: `missing needle file ${needlesFile}: run the e2e suites first` };
  }

  const needles = readNeedles(text);
  if (needles.length === 0) {
    return {
      ok: false,
      reason: `empty needle file ${needlesFile}: the e2e suites record the values they use`,
    };
  }

  const leaked = leakedNeedleLines(logs, needles);
  const leakedServer = leakedNeedleLines(logs, SERVER_NEEDLES);
  if (leaked.length > 0 || leakedServer.length > 0) {
    const parts = [];
    if (leaked.length > 0) parts.push(`values from ${needlesFile} lines ${leaked.join(", ")}`);
    if (leakedServer.length > 0) parts.push(`built-in needles ${leakedServer.join(", ")}`);
    return { ok: false, reason: `stack logs contain ${parts.join(" and ")}` };
  }
  const total = needles.length + SERVER_NEEDLES.length;
  return { ok: true, reason: `stack logs are clean of ${total} checked value(s)` };
}

if (import.meta.main) {
  const needlesFile = process.argv[2] ?? "tests/e2e/.secrets-used";
  const logs = execFileSync("docker", ["compose", "logs", "--no-color", "orrery", "postgres"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = await checkLogs({ logs, needlesFile });
  if (result.ok) console.log(result.reason);
  else console.error(result.reason);
  process.exit(result.ok ? 0 : 1);
}
