// The browser test setup for Orrery: Playwright drives the web app like a person would.
// Later tickets add specs here; they all run against the same ORRERY_URL as the REST
// checks (docker compose --profile mail-test up -d --build --wait, then pnpm test:e2e).
//
// On machines without a Playwright-managed browser download, set CHROMIUM_PATH to a
// system Chromium instead.
import { defineConfig } from "@playwright/test";

const baseURL = process.env.ORRERY_URL;
if (!baseURL)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

export default defineConfig({
  testDir: ".",
  // Only the browser specs; the REST checks are the vitest *.test.ts files in this package.
  testMatch: "**/*.spec.ts",
  // The bootstrap flow is one sequential story against one instance.
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL,
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
  },
});
