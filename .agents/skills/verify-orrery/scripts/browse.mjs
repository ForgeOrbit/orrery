// Drive the Orrery web app in headless Chromium and save proof.
//   node browse.mjs <rundir> <path> [--expect-text "Server: ok"] [--expect-role heading:Orrery]
//     [--click-link Orrery] [--fill "Email=admin@orrery.test"] [--click-button "Sign in"]
//     [--allow-http 401] [--allow-console ZodError] [--slug home-fresh]
// Writes <rundir>/evidence/<slug>.{png,aria.txt,json} and exits non-zero if an expectation fails
// or the page logged console errors / failed requests. --allow-http is repeatable and marks a
// status as expected (the signed-out home legitimately answers 401 for session and workspaces);
// --allow-console is repeatable and ignores a console error whose text contains the value (the
// database-down reload shows the designed "Server: unreachable" page and logs a ZodError).
// --slug names the evidence files, so one page can be captured in several states. --fill is
// repeatable (label=value) and runs before --click-button, so forms are driven by label and role.
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const [runDir, path = "/", ...rest] = process.argv.slice(2);
if (!runDir) throw new Error("usage: browse.mjs <rundir> <path> [flags]");
const flag = (n) => rest.flatMap((a, i) => (a === n ? [rest[i + 1]] : []));
const env = Object.fromEntries(
  readFileSync(`${runDir}/env`, "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
);

// Playwright comes from the machine's mise install (not a repo dependency). Override with PLAYWRIGHT_MODULE.
const pwDir =
  process.env.PLAYWRIGHT_MODULE ??
  execSync('dirname "$(readlink -f "$(command -v playwright)")"').toString().trim() + "/..";
const { chromium } = createRequire(pwDir + "/playwright/x.js")("playwright");

// The playwright-managed browser download can lag the library; prefer a system Chromium if present.
const executablePath =
  process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const page = await browser.newPage();
const allowedHttp = new Set(flag("--allow-http").map(Number));
const allowedConsoleText = flag("--allow-console");
// The browser also logs "Failed to load resource: ... status of 401" for an expected
// status; the console message has no URL, so match its status against the allow list.
const allowedConsole = (text) => {
  if (allowedConsoleText.some((part) => text.includes(part))) return true;
  const status = text.match(/status of (\d{3})/)?.[1];
  return status !== undefined && allowedHttp.has(Number(status));
};
const problems = [];
page.on(
  "console",
  (m) => m.type() === "error" && !allowedConsole(m.text()) && problems.push(`console: ${m.text()}`),
);
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
page.on(
  "response",
  (r) =>
    r.status() >= 400 &&
    !allowedHttp.has(r.status()) &&
    problems.push(`http ${r.status()}: ${r.url()}`),
);

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, error: String(e.message).split("\n")[0] });
  }
};

const nav = await page.goto(env.URL + path, { waitUntil: "networkidle" });
for (const name of flag("--click-link")) {
  await page.getByRole("link", { name }).click();
  await page.waitForLoadState("networkidle");
}
for (const pair of flag("--fill")) {
  const at = pair.indexOf("=");
  if (at < 1) throw new Error(`--fill needs label=value, got "${pair}"`);
  await page.getByLabel(pair.slice(0, at)).fill(pair.slice(at + 1));
}
for (const name of flag("--click-button")) {
  await page.getByRole("button", { name }).click();
  await page.waitForLoadState("networkidle");
}
for (const t of flag("--expect-text"))
  await check(`text "${t}"`, () => page.getByText(t).first().waitFor({ timeout: 5000 }));
for (const r of flag("--expect-role")) {
  const [role, ...n] = r.split(":");
  await check(`role ${role} "${n.join(":")}"`, () =>
    page
      .getByRole(role, { name: n.join(":") })
      .first()
      .waitFor({ timeout: 5000 }),
  );
}

const slug =
  flag("--slug")[0] ?? (path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home");
mkdirSync(`${runDir}/evidence`, { recursive: true });
await page.screenshot({ path: `${runDir}/evidence/${slug}.png`, fullPage: true });
writeFileSync(`${runDir}/evidence/${slug}.aria.txt`, await page.locator("body").ariaSnapshot());
const out = { url: page.url(), documentStatus: nav?.status(), results, problems };
writeFileSync(`${runDir}/evidence/${slug}.json`, JSON.stringify(out, null, 2));
await browser.close();
console.log(JSON.stringify(out, null, 2));
process.exit(results.every((r) => r.ok) && problems.length === 0 ? 0 : 1);
