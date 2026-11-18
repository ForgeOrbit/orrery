import { describe, expect, it } from "vitest";
import { createApp } from "../../platform/http.ts";
import { createSystemFeature } from "./index.ts";

function appWith(db: "up" | "down") {
  const ping = db === "up" ? async () => {} : async () => Promise.reject(new Error("db down"));
  return createApp({ features: [createSystemFeature({ ping })], publicUrl: "http://orrery.test" });
}

describe("health", () => {
  it("reports liveness", async () => {
    const res = await appWith("up").request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const res = await appWith("down").request("/readyz");
    expect(res.status).toBe(503);
  });
});
