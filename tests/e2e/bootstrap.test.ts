// Black-box bootstrap checks (issue #21): wrong or missing secrets cannot create the
// administrator. These talk to a running Orrery over HTTP and never import server code.
// They assume a freshly created stack; the full setup + restart flow lives in
// bootstrap.spec.ts (Playwright), which consumes bootstrap.
//
//   docker compose up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { Problem } from "@orrery/contract";
import { describe, expect, it } from "vitest";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

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

  it("refuses a wrong, empty, or missing secret", async () => {
    // The instance's own BOOTSTRAP_SECRET, whatever it is, is none of these.
    for (const body of [
      {
        secret: "definitely-not-the-secret",
        email: "admin@example.com",
        password: "a-valid-password",
      },
      { secret: "", email: "admin@example.com", password: "a-valid-password" },
      { email: "admin@example.com", password: "a-valid-password" },
    ]) {
      const res = await postJson("/api/setup/admin", body);
      expect(res.ok).toBe(false);
      // 400 invalid body, 401 wrong secret, 403 no secret configured: refused either way.
      expect([400, 401, 403]).toContain(res.status);
    }

    // Refused attempts created nothing: setup is still open, and visiting status
    // (GET) changed nothing either.
    const status = await fetch(new URL("/api/setup/status", baseUrl));
    expect(await status.json()).toEqual({ setupComplete: false });
  });

  it("answers the session check with 401 when nobody is signed in", async () => {
    const res = await fetch(new URL("/api/auth/session", baseUrl));
    expect(res.status).toBe(401);
    const body = Problem.parse(await res.json());
    expect(Object.keys(body)).toEqual(["message"]);
  });
});
