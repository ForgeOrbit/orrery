// Black-box bootstrap checks (issue #21): wrong or missing secrets cannot create the
// administrator. These talk to a running Orrery over HTTP and never import server code.
// They assume a freshly created stack; the full setup + restart flow lives in
// bootstrap.spec.ts (Playwright), which consumes bootstrap.
//
//   docker compose up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
//
// When the stack was started with BOOTSTRAP_SECRET, pass the same value as
// ORRERY_SETUP_SECRET so each refusal can expect its exact status.
import { describe, expect, it } from "vitest";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

// Set when the tests know the stack's bootstrap secret. Unset means the stack runs
// without one, so setup is unavailable (403) rather than secret-checked (401).
const refusedWith = process.env.ORRERY_SETUP_SECRET === undefined ? 403 : 401;

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

    const empty = await postJson("/api/setup/admin", {
      secret: "",
      email: "admin@example.com",
      password: "a-valid-password",
    });
    expect(empty.status).toBe(400);

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
    expect(await res.json()).toEqual({ message: expect.any(String) });
  });
});
