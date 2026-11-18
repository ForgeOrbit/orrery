// The full bootstrap story, through the browser (issue #21): refuse a wrong secret,
// create the first administrator once, sign in, and prove a restart keeps setup closed.
// Black-box: real pages against a running Orrery, never server code.
//
// Requires a freshly created stack and these environment variables:
//   ORRERY_URL            the running instance, for example http://localhost:8080
//   ORRERY_SETUP_SECRET   the same value the instance got in BOOTSTRAP_SECRET
//   ORRERY_RESTART_CMD    optional; a command that restarts the server, for example
//                         docker compose -f <repo>/compose.yaml restart orrery
import { exec as execCallback } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

const exec = promisify(execCallback);

// Empty string only when the variable is unset; the whole file is skipped then.
const setupSecret = process.env.ORRERY_SETUP_SECRET ?? "";
const restartCommand = process.env.ORRERY_RESTART_CMD;

test.skip(!setupSecret, "Set ORRERY_SETUP_SECRET to the instance's BOOTSTRAP_SECRET.");

const email = "admin@orrery.test";
const password = "browser-checked-admin-password";

// Every secret this suite sends or receives, recorded for the post-run log check
// (scripts/check-e2e-logs.mjs): the bootstrap secret, the passwords, and the session
// cookies the server hands back, plus the stored-hash pattern Postgres DETAIL lines
// would carry.
const secretsUsed = new URL("./.secrets-used", import.meta.url).pathname;
const recordSecret = (value: string) => appendFile(secretsUsed, `${value}\n`, "utf8");

test.beforeAll(async () => {
  await recordSecret(setupSecret);
  await recordSecret(password);
  await recordSecret("definitely-not-the-secret");
  await recordSecret("scrypt$");
});

async function fillSetupForm(page: Page, secret: string) {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Set up Orrery" })).toBeVisible();
  await page.getByLabel("Setup secret").fill(secret);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  // The cookies the server just set are secrets the logs must never contain.
  for (const cookie of await page.context().cookies()) {
    await recordSecret(cookie.value);
  }
}

test("refuses a wrong setup secret in the browser", async ({ page }) => {
  await fillSetupForm(page, "definitely-not-the-secret");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid setup secret.");

  // Refused, so nothing changed: setup is still open and the page stays usable.
  const status = await page.request.get("/api/setup/status");
  expect(await status.json()).toEqual({ setupComplete: false });
});

test("creates the first administrator and signs in", async ({ page }) => {
  await fillSetupForm(page, setupSecret);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  // Setup closed exactly once: the status reflects it and a second attempt is refused,
  // even with the correct secret.
  const status = await page.request.get("/api/setup/status");
  expect(await status.json()).toEqual({ setupComplete: true });
  const second = await page.request.post("/api/setup/admin", {
    data: { secret: setupSecret, email: "second@example.com", password },
  });
  expect(second.status()).toBe(409);

  // First login through the browser.
  await signIn(page);
});

test("keeps setup closed and login working after a restart", async ({ page }) => {
  test.skip(
    !restartCommand,
    "Set ORRERY_RESTART_CMD to a command that restarts the server, for example " +
      "'docker compose -f <repo>/compose.yaml restart orrery'.",
  );

  // The skip above guarantees a command is present; the empty string is unreachable.
  await exec(restartCommand ?? "", { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        try {
          return (await page.request.get("/readyz")).ok();
        } catch {
          // The server is still coming back; the poll tries again.
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();

  // Restart preserved completion: setup stays closed and refuses the correct secret.
  const status = await page.request.get("/api/setup/status");
  expect(await status.json()).toEqual({ setupComplete: true });
  const attempt = await page.request.post("/api/setup/admin", {
    data: { secret: setupSecret, email: "third@example.com", password },
  });
  expect(attempt.status()).toBe(409);

  // And the administrator can still sign in through the browser.
  await signIn(page);
});
