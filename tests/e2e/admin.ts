// Shared facts about the one installation under test, so the suites that build on the
// bootstrap story (bootstrap.spec.ts first, then the later ones) can never drift apart.
import { appendFile } from "node:fs/promises";

// The first administrator, created once by bootstrap.spec.ts; the later suites sign in
// as this account.
export const ADMIN_EMAIL = "admin@orrery.test";
export const ADMIN_PASSWORD = "browser-checked-admin-password";

// Every secret this suite sends or receives, recorded for the post-run log check
// (scripts/check-e2e-logs.mjs): the stack's logs must never contain any of them, and
// the check covers the real values, not hand-made copies. test:e2e empties the file
// before each run.
const secretsUsed = new URL("./.secrets-used", import.meta.url).pathname;

export const recordSecret = (value: string) => appendFile(secretsUsed, `${value}\n`, "utf8");
