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

describe("loadConfig: ORRERY_ENCRYPTION_KEY", () => {
  it("treats an unset, empty, or blank key as no key", () => {
    expect(loadConfig({ ...baseEnv }).ORRERY_ENCRYPTION_KEY).toBeUndefined();
    expect(
      loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "" }).ORRERY_ENCRYPTION_KEY,
    ).toBeUndefined();
    expect(
      loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "   " }).ORRERY_ENCRYPTION_KEY,
    ).toBeUndefined();
  });

  it("decodes a 32-byte base64 key to the 32 bytes", () => {
    const key = loadConfig({
      ...baseEnv,

      ORRERY_ENCRYPTION_KEY: "dGhpcy1rZXktaXMtanVzdC1hLXRlc3QtZml4dHVyZSE=",
    }).ORRERY_ENCRYPTION_KEY;
    expect(key).toBeInstanceOf(Buffer);
    expect(key?.byteLength).toBe(32);
  });

  it("refuses to start with a key that is not base64 for exactly 32 bytes", () => {
    expect(() => loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "aGk=" })).toThrow(
      /ORRERY_ENCRYPTION_KEY/,
    );

    expect(() =>
      loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/ORRERY_ENCRYPTION_KEY/);

    expect(() => loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: "not base64!!" })).toThrow(
      /ORRERY_ENCRYPTION_KEY/,
    );
  });

  it("refuses a stray character inside an otherwise valid key", () => {
    const valid = "5JxZLMqonzkGHjJwLLuzM6d6fQ6m7onmSI+7yeB9NW0=";
    const stray = `${valid.slice(0, 22)}*${valid.slice(22)}`;
    expect(() => loadConfig({ ...baseEnv, ORRERY_ENCRYPTION_KEY: stray })).toThrow(
      /ORRERY_ENCRYPTION_KEY/,
    );
  });
});
