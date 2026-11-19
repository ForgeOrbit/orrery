// Black-box bootstrap checks (issue #21): wrong or missing secrets cannot create the
// administrator. These talk to a running Orrery over HTTP and never import server code.
// They assume a freshly created stack; the full setup + restart flow lives in
// bootstrap.spec.ts (Playwright), which consumes bootstrap.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
//
// When the stack was started with BOOTSTRAP_SECRET, pass the same value as
// ORRERY_SETUP_SECRET so each refusal can expect its exact status.
import { beforeAll, describe, expect, it } from "vitest";
import { recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

// Set when the tests know the stack's bootstrap secret. Unset means the stack runs
// without one, so setup is unavailable (403) rather than secret-checked (401).
const refusedWith = process.env.ORRERY_SETUP_SECRET === undefined ? 403 : 401;

// Every secret this suite sends or knows is recorded in one place (./admin.ts), for
// the post-run log check (scripts/check-e2e-logs.mjs).
beforeAll(async () => {
  for (const value of ["definitely-not-the-secret", "a-valid-password"]) {
    await recordSecret(value);
  }
  const setupSecret = process.env.ORRERY_SETUP_SECRET;
  if (setupSecret !== undefined) await recordSecret(setupSecret);
});

const postJson = (path: string, body: unknown) =>
  fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("initial setup, while it is still open", () => {
  it("reports setup as incomplete", async () => {
    const res = await fetch(new URL("/api/setup/status", baseUrl));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setupComplete: false });
  });

  it("refuses a wrong, an empty, and a missing secret, each with its exact status", async () => {
    // A wrong secret is checked by the service: 401 when a secret is configured, 403
    // when none is. Empty and missing are shape errors the contract rejects with 400.
    const wrong = await postJson("/api/setup/admin", {
      secret: "definitely-not-the-secret",
      email: "admin@example.com",
      password: "a-valid-password",
    });
    expect(wrong.status).toBe(refusedWith);
    expect(wrong.headers.get("content-type")).toBe("application/problem+json");
    expect(await wrong.json()).toMatchObject({
      code: refusedWith === 401 ? "invalid_secret" : "setup_unavailable",
    });

    const empty = await postJson("/api/setup/admin", {
      secret: "",
      email: "admin@example.com",
      password: "a-valid-password",
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      code: "validation_failed",
      errors: [{ pointer: "/secret", detail: expect.any(String) }],
    });

    const missing = await postJson("/api/setup/admin", {
      email: "admin@example.com",
      password: "a-valid-password",
    });
    expect(missing.status).toBe(400);

    // Refused attempts created nothing: setup is still open, and visiting status
    // (GET) changed nothing either.
    const status = await fetch(new URL("/api/setup/status", baseUrl));
    expect(await status.json()).toEqual({ setupComplete: false });
  });

  it("answers the session check with 401 when nobody is signed in", async () => {
    const res = await fetch(new URL("/api/auth/session", baseUrl));
    expect(res.status).toBe(401);
    // Every REST error is an RFC 9457 Problem with a stable code (ADR-0003).
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({
      type: "urn:orrery:problem:not_signed_in",
      title: expect.any(String),
      status: 401,
      code: "not_signed_in",
    });
  });
});
