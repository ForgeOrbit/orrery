import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(key: Buffer, stored: string): string | undefined {
  const parts = stored.split(":");
  if (parts.length !== 4) return undefined;
  const [version, ivPart, tagPart, ciphertextPart] = parts;
  if (
    version !== "v1" ||
    ivPart === undefined ||
    tagPart === undefined ||
    ciphertextPart === undefined
  ) {
    return undefined;
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}
