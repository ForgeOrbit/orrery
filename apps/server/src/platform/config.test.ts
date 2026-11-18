import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const baseEnv = { DATABASE_URL: "postgres://orrery:pw@localhost:5432/orrery" };

describe("loadConfig: BOOTSTRAP_SECRET", () => {
  it("treats an unset, empty, or blank secret as not configured", () => {
    expect(loadConfig({ ...baseEnv }).BOOTSTRAP_SECRET).toBeUndefined();
    expect(loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: "" }).BOOTSTRAP_SECRET).toBeUndefined();
    expect(loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: "   " }).BOOTSTRAP_SECRET).toBeUndefined();
  });

  it("refuses to start with a configured secret shorter than 32 characters", () => {
    expect(() => loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: "a".repeat(31) })).toThrow(
      /BOOTSTRAP_SECRET/,
    );
  });

  it("accepts a secret of at least 32 characters", () => {
    const secret = "a".repeat(32);
    expect(loadConfig({ ...baseEnv, BOOTSTRAP_SECRET: secret }).BOOTSTRAP_SECRET).toBe(secret);
  });
});
