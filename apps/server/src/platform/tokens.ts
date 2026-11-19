// Random bearer tokens, as stored: only the SHA-256 of the token is kept, so a stored
// row is useless to a dump and the token itself is only ever held by its bearer. Every
// feature that issues a bearer secret hashes it the same way — one implementation.
import { createHash } from "node:crypto";

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
