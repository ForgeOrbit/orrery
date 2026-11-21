import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets.ts";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe("secrets at rest", () => {
  it("round-trips a secret, and a different key cannot read it", () => {
    const stored = encryptSecret(KEY, "the-mail-relay-passphrase");
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain("the-mail-relay-passphrase");
    expect(decryptSecret(KEY, stored)).toBe("the-mail-relay-passphrase");
    expect(decryptSecret(OTHER_KEY, stored)).toBeUndefined();
  });

  it("stores a fresh IV every time", () => {
    const first = encryptSecret(KEY, "same plaintext");
    const second = encryptSecret(KEY, "same plaintext");
    expect(first).not.toBe(second);
  });

  it("refuses a stored value that is not exactly four v1 parts", () => {
    const stored = encryptSecret(KEY, "the-mail-relay-passphrase");

    expect(decryptSecret(KEY, `${stored}:extra`)).toBeUndefined();

    expect(decryptSecret(KEY, stored.slice(0, stored.lastIndexOf(":")))).toBeUndefined();

    expect(decryptSecret(KEY, "v2:aaaa:bbbb:cccc")).toBeUndefined();
  });

  it("refuses a short IV and a truncated tag", () => {
    const stored = encryptSecret(KEY, "the-mail-relay-passphrase");
    const [version, iv, tag, ciphertext] = stored.split(":");
    if (
      version === undefined ||
      iv === undefined ||
      tag === undefined ||
      ciphertext === undefined
    ) {
      throw new Error("the encrypted shape is not what the test expects");
    }
    const shortIv = Buffer.from(iv, "base64url").subarray(0, 11).toString("base64url");
    expect(decryptSecret(KEY, [version, shortIv, tag, ciphertext].join(":"))).toBeUndefined();
    const truncatedTag = Buffer.from(tag, "base64url").subarray(0, 15).toString("base64url");
    expect(decryptSecret(KEY, [version, iv, truncatedTag, ciphertext].join(":"))).toBeUndefined();
  });
});
