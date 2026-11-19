// Random bearer tokens, as stored: only the SHA-256 of the token is kept, so a stored
// row is useless to a dump and the token itself is only ever held by its bearer.
// Accounts' session cookies, settings' verification tokens, and invitations' links all
// hash the same way — one implementation, not three.
import { createHash } from "node:crypto";

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
