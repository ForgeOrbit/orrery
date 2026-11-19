import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { WorkspaceKind } from "@orrery/contract";
import type {
  LoginRequest,
  SetupAdminRequest,
  SetupAdminResponse,
  SetupStatus,
} from "@orrery/contract";
import { and, eq, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { browserSessions, humans, instanceSetup, workspaces } from "../../db/schema.ts";

// The service is the only file in a feature that decides anything. rest.ts and mcp.ts call it.

// Email is normalized (trim, then lowercase) in exactly one place: the contract's Email
// schema, which every request body is parsed with. The humans table's check constraint
// enforces the same rule at the bottom, for any writer that skips the contract.

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// Password hashing: node's scrypt with per-hash salt and recorded parameters.
// Passwords never appear in responses or logs; only this string is stored.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;
const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || saltB64 === undefined || hashB64 === undefined) return false;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(hashB64, "base64url");
  if (expected.length === 0 || expected.length > 256) return false;
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64url"), expected.length, {
    N: n,
    r,
    p,
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Verify against a fixed hash when the account does not exist, so an unknown email
// costs the same work as a wrong password and the answer is identical either way.
const DUMMY_HASH =
  "scrypt$16384$8$1$b3JyZXJ5LWR1bW15LXNhbHQtMTY$6Awy600SskzLpdZgeUpvnyksgenN_1gvcbM0bdSXr2z1bBJFVDN3J6Zn3op2hfS_fK_UaWrf57BezjLa2V2Cxw";

function secretsEqual(presented: string, configured: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The browser session cookie holds a random token; only its SHA-256 is stored.
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Returns the constraint name of a Postgres unique violation (SQLSTATE 23505), walking
// through driver and ORM wrappers, or undefined for anything else.
function uniqueConstraintName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 3; depth++) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "23505") {
      const name = candidate.constraint ?? candidate.constraint_name;
      if (typeof name === "string") return name;
      return undefined;
    }
    current = candidate.cause;
  }
  return undefined;
}

export type AccountsErrorKind =
  | "setup_unavailable"
  | "invalid_secret"
  | "setup_complete"
  | "invalid_credentials";

const messages = {
  setup_unavailable:
    "Initial setup is not available. Set BOOTSTRAP_SECRET in the server's environment.",
  invalid_secret: "Invalid setup secret.",
  setup_complete: "Initial setup is already complete.",
  invalid_credentials: "Invalid email or password.",
} as const satisfies Record<AccountsErrorKind, string>;

export class AccountsError extends Error {
  readonly kind: AccountsErrorKind;

  constructor(kind: AccountsErrorKind) {
    super(messages[kind]);
    this.name = "AccountsError";
    this.kind = kind;
  }
}

// Login input that fails validation (malformed or overlong) counts as wrong credentials,
// so every failed sign-in looks the same to the caller.
export function rejectLogin(): AccountsError {
  return new AccountsError("invalid_credentials");
}

// The account behind a live browser session: what any feature needs to authorize a
// request. The cookie's token is accounts' transport detail; this is its account-level
// answer.
export interface SessionAccount {
  humanId: string;
  email: string;
  isSystemAdministrator: boolean;
  emailVerifiedAt: Date | null;
}

// What the service decides about browser sessions: how long they last, and whether the
// deployment's public URL makes cookies Secure. The cookie's transport attributes are
// rest.ts's business.
export interface SessionPolicy {
  maxAgeSeconds: number;
  secure: boolean;
}

export interface AccountsDeps {
  db: PostgresJsDatabase;
  // The deployment-supplied bootstrap secret (env var BOOTSTRAP_SECRET). Undefined means
  // no secret is configured: setup cannot create the administrator.
  setupSecret: string | undefined;
  // The URL people use to reach the server. Its scheme decides the cookie's Secure flag.
  publicUrl: string;
}

export interface AccountsService {
  setupStatus(): Promise<SetupStatus>;
  setupAdmin(input: SetupAdminRequest): Promise<SetupAdminResponse>;
  login(input: LoginRequest): Promise<{ token: string; email: string }>;
  session(token: string): Promise<SessionAccount | null>;
  sessionPolicy(): SessionPolicy;
  // Marks an account's email verified, at database time, inside the caller's
  // transaction: the humans table is accounts' to write, but the flow that earns the
  // mark (issue #22's token redemption) is another feature's.
  markEmailVerified(humanId: string, tx: DbTransaction): Promise<void>;
}

export function createAccountsService({
  db,
  setupSecret,
  publicUrl,
}: AccountsDeps): AccountsService {
  const sessionPolicy: SessionPolicy = {
    maxAgeSeconds: SESSION_TTL_SECONDS,
    secure: publicUrl.startsWith("https://"),
  };
  return {
    sessionPolicy: () => sessionPolicy,

    async setupStatus() {
      const rows = await db.select({ id: instanceSetup.id }).from(instanceSetup).limit(1);
      return { setupComplete: rows.length > 0 };
    },

    // Creates the administrator, its personal workspace, and the record that closes
    // bootstrap, all in one transaction. The singleton row in instance_setup is claimed by
    // its primary key, so of any number of concurrent attempts exactly one can win.
    async setupAdmin(input: SetupAdminRequest) {
      if (setupSecret === undefined) throw new AccountsError("setup_unavailable");
      if (!secretsEqual(input.secret, setupSecret)) throw new AccountsError("invalid_secret");

      const humanId = randomUUID();
      const passwordHash = await hashPassword(input.password);

      try {
        await db.transaction(async (tx) => {
          await tx
            .insert(humans)
            .values({ id: humanId, email: input.email, passwordHash, isSystemAdministrator: true });
          await tx.insert(workspaces).values({
            id: randomUUID(),
            kind: WorkspaceKind.enum.personal,
            name: "Personal",
            personalOwnerHumanId: humanId,
          });
          await tx.insert(instanceSetup).values({ id: true, administratorHumanId: humanId });
        });
      } catch (error) {
        const constraint = uniqueConstraintName(error);
        // Either constraint means bootstrap is already closed — by the singleton for a
        // different-email race, or by the winner of a same-email race — so the honest
        // answer to every loser is that setup is complete.
        if (constraint === "instance_setup_pkey" || constraint === "humans_email_unique") {
          throw new AccountsError("setup_complete");
        }
        throw error;
      }
      return { email: input.email };
    },

    // Login failures are uniform: an unknown email and a wrong password cost the same
    // work and answer with the same error, whatever shape the presented password has.
    async login(input: LoginRequest) {
      const [human] = await db
        .select({ id: humans.id, passwordHash: humans.passwordHash })
        .from(humans)
        .where(eq(humans.email, input.email))
        .limit(1);

      if (human === undefined) {
        await verifyPassword(DUMMY_HASH, input.password);
        throw new AccountsError("invalid_credentials");
      }
      if (!(await verifyPassword(human.passwordHash, input.password))) {
        throw new AccountsError("invalid_credentials");
      }

      const token = randomBytes(32).toString("base64url");
      await db.insert(browserSessions).values({
        id: randomUUID(),
        humanId: human.id,
        tokenHash: tokenHash(token),
        expiresAt: sql`now() + make_interval(secs => ${sessionPolicy.maxAgeSeconds})`,
      });
      return { token, email: input.email };
    },

    async session(token: string) {
      const [row] = await db
        .select({
          humanId: humans.id,
          email: humans.email,
          isSystemAdministrator: humans.isSystemAdministrator,
          emailVerifiedAt: humans.emailVerifiedAt,
        })
        .from(browserSessions)
        .innerJoin(humans, eq(humans.id, browserSessions.humanId))
        .where(
          and(
            eq(browserSessions.tokenHash, tokenHash(token)),
            gt(browserSessions.expiresAt, sql`now()`),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    // Inside the caller's transaction: the mark commits with the flow that earned it
    // or not at all.
    async markEmailVerified(humanId: string, tx: DbTransaction) {
      await tx
        .update(humans)
        .set({ emailVerifiedAt: sql`now()` })
        .where(eq(humans.id, humanId));
    },
  };
}

// The one startup warning accounts owns: a fresh installation with no bootstrap secret
// can never be set up, and the installer should learn that before trying. main.ts
// reports whatever this returns; the decision stays here.
export async function startupWarnings({
  db,
  setupSecret,
}: Pick<AccountsDeps, "db" | "setupSecret">): Promise<string[]> {
  if (setupSecret !== undefined) return [];
  const rows = await db.select({ id: instanceSetup.id }).from(instanceSetup).limit(1);
  return rows.length > 0 ? [] : ["initial setup cannot run until BOOTSTRAP_SECRET is set"];
}
