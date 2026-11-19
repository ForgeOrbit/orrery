// Secrets at rest (ADR-0004): AES-256-GCM with the deployment's key. Callers store only
// the ciphertext; the key and the plaintext never reach a log, a response, or a caller
// that does not need to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;

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
// for the case; nothing here throws key or plaintext material around.
export function decryptSecret(key: Buffer, stored: string): string | undefined {
  const [version, ivPart, tagPart, ciphertextPart] = stored.split(":");
  if (
    version !== "v1" ||
    ivPart === undefined ||
    tagPart === undefined ||
    ciphertextPart === undefined
  ) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A wrong key fails the GCM auth tag; a corrupt row fails the base64 or the padding.
    return undefined;
  }
}
