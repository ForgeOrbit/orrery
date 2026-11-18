// Fails when the running stack's logs contain a value they must never contain: the
// bootstrap secret, test passwords, or a session cookie. The e2e job runs this after the
// tests, so a leak fails CI even when every request succeeded.
//
//   node scripts/check-e2e-logs.mjs "bootstrap-secret=$BOOTSTRAP_SECRET" "password=..." ...
//
// Each argument is `label=value` (or a bare value, labeled "secret"). Only the label is
// printed on failure, never the value.
import { execFileSync } from "node:child_process";

const needles = process.argv.slice(2).map((arg) => {
  const separator = arg.indexOf("=");
  return separator === -1
    ? { label: "secret", value: arg }
    : { label: arg.slice(0, separator), value: arg.slice(separator + 1) };
});
if (needles.length === 0) {
  console.error("usage: node scripts/check-e2e-logs.mjs <label=value>...");
  process.exit(2);
}

const logs = execFileSync("docker", ["compose", "logs", "--no-color", "orrery"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const leaked = needles.filter((needle) => needle.value.length > 0 && logs.includes(needle.value));
if (leaked.length > 0) {
  console.error(
    `e2e logs contain values they must never contain: ${leaked.map((n) => n.label).join(", ")}`,
  );
  process.exit(1);
}
console.log(`e2e logs are clean of ${needles.length} checked value(s)`);
