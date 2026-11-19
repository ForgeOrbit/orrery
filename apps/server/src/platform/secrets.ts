// Secrets at rest (ADR-0004): AES-256-GCM with the deployment's key. Callers store only
// the ciphertext; the key and the plaintext never reach a log, a response, or a caller
// that does not need to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// The format this module writes and reads: v1, 12-byte IV, 16-byte GCM tag.
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Encrypts one secret as a versioned ciphertext, v1:<iv>:<tag>:<ct> in base64url. The
// version prefix says how to read it back, so a future scheme becomes v2 without
// touching stored rows or a migration.
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

// The plaintext again, or undefined when this key cannot read the stored value: the key
// changed, the row is corrupt, or the version is unknown. Callers answer their own error
// for the case; nothing here throws key or plaintext material around. The stored format
// is parsed strictly: exactly four parts, a 12-byte IV, a 16-byte tag, and no more.
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
    // A wrong key fails the GCM auth tag; a corrupt row fails the base64 or the padding.
    return undefined;
  }
}
