import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { accountRecoveryEvents, passwordResetTokens } from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import type { OutgoingMail } from "../settings/index.ts";

// The service is the only file in this feature that decides anything. rest.ts and the
// local recovery command call it; neither makes a policy decision of its own.

// A short-lived implementation default (#20): the link exists to be redeemed minutes
// after the email arrives. Expiry is checked in database time at redemption, never by
// a deployed clock or a process-local timer.
const RESET_TTL_SECONDS = 60 * 60;

// The same answer for every address, whatever the outcome. Neither the body nor the
// status reveals whether an account exists or whether its email is verified (#20).
export const PASSWORD_RESET_REQUEST_MESSAGE =
  "If that address is eligible, a password reset link has been sent. Check your mailbox.";
export const PASSWORD_RESET_CONFIRM_MESSAGE =
  "Your password has been reset. Sign in with your new password.";
export const LOCAL_RECOVERY_MESSAGE =
  "The password was changed locally. All browser sessions for that account were signed out.";

function resetMail(email: string, token: string, publicUrl: string): OutgoingMail {
  return {
    to: email,
    subject: "Reset your Orrery password",
    text: [
      `A password reset was requested for ${email}.`,
      "",
      `Choose a new password: ${publicUrl}/reset-password?token=${token}`,
      "",
      "This link works once and is valid for one hour. Opening it changes nothing; the password is set by the page it opens.",
      "",
      "If you did not ask for this, ignore the email. Your password has not changed.",
    ].join("\n"),
  };
}

export type RecoveryErrorKind =
  | "reset_token_invalid"
  | "account_not_found"
  | "not_system_administrator";

const messages = {
  reset_token_invalid: "This password reset link is invalid, expired, or already used.",
  account_not_found: "No account has that email address.",
  not_system_administrator:
    "Local recovery is for system administrators only. An ordinary account recovers by email.",
} as const satisfies Record<RecoveryErrorKind, string>;

export class RecoveryError extends Error {
  readonly kind: RecoveryErrorKind;

  constructor(kind: RecoveryErrorKind) {
    super(messages[kind]);
    this.name = "RecoveryError";
    this.kind = kind;
  }
}

// The narrow seams recovery borrows from accounts. Accounts owns humans, password
// hashing, and browser sessions; this feature decides when those writes are earned.
export interface RecoveryAccountAccess {
  accountByEmail(
    email: string,
    tx?: DbTransaction,
  ): Promise<{
    humanId: string;
    email: string;
    emailVerifiedAt: Date | null;
    isSystemAdministrator: boolean;
  } | null>;
  setPassword(humanId: string, password: string, tx: DbTransaction): Promise<void>;
  invalidateBrowserSessions(humanId: string, tx: DbTransaction): Promise<void>;
}

export interface RecoveryDeps {
  db: PostgresJsDatabase;
  accounts: RecoveryAccountAccess;
  // Settings owns the one mail transport. The local command does not send mail and
  // supplies a sender that refuses to be called, so a bug there fails loudly.
  deliver: (mail: OutgoingMail) => Promise<void>;
  publicUrl: string;
  log?: Logger;
}

export interface RecoveryService {
  // Always answers the same way. A token and an email are created only for a verified
  // address; a delivery failure leaves no live token and still answers the same way.
  requestReset(email: string): Promise<{ message: string }>;
  // Redeems the token and changes the password in one transaction, evaluated in
  // database time. Single-use: the conditional update is the only way to consume it.
  confirmReset(token: string, password: string): Promise<{ message: string }>;
  // Administrator's on-server command: no email, no SMTP, no token, no public bypass.
  // Only a system administrator may use it; an ordinary account recovers by email.
  // Works for an unverified administrator, because that is how bootstrap recovers.
  localRecover(email: string, password: string): Promise<{ email: string; message: string }>;
}

// The one credential change both flows earn, inside the caller's transaction: a new
// password hash, every prior browser session signed out, one secret-free event, and
// every other unused reset token for the account revoked. A password change retires
// all outstanding links at once: with several requested, the others must not stay
// live even after one was redeemed or an administrator recovered locally. Agent keys
// are another feature's table; bootstrap and workspaces are never touched.
async function changePasswordAndSignOut(
  tx: DbTransaction,
  accounts: RecoveryAccountAccess,
  humanId: string,
  password: string,
  type: "password_reset_completed" | "local_recovery_completed",
) {
  await accounts.setPassword(humanId, password, tx);
  await accounts.invalidateBrowserSessions(humanId, tx);
  await tx
    .update(passwordResetTokens)
    .set({ usedAt: sql`now()` })
    .where(and(eq(passwordResetTokens.humanId, humanId), isNull(passwordResetTokens.usedAt)));
  await tx.insert(accountRecoveryEvents).values({ id: randomUUID(), humanId, type });
}

export function createRecoveryService({
  db,
  accounts,
  deliver,
  publicUrl,
  log,
}: RecoveryDeps): RecoveryService {
  return {
    async requestReset(email) {
      // Look up the address, but answer identically whether it exists, is unverified,
      // delivered, or failed. No event is written for nothing that happened: an
      // unverified or unknown address gets no mail and no token.
      const account = await accounts.accountByEmail(email);
      if (account !== null && account.emailVerifiedAt !== null) {
        const token = randomBytes(32).toString("base64url");
        const id = randomUUID();
        await db.insert(passwordResetTokens).values({
          id,
          humanId: account.humanId,
          tokenHash: tokenHash(token),
          expiresAt: sql`now() + make_interval(secs => ${RESET_TTL_SECONDS})`,
        });
        try {
          await deliver(resetMail(account.email, token, publicUrl));
          await db.insert(accountRecoveryEvents).values({
            id: randomUUID(),
            humanId: account.humanId,
            type: "password_reset_requested",
          });
        } catch (error) {
          // The email never left, so its token must not be redeemable. The earlier
          // messages stay identical: a broken relay must not disclose an address.
          log?.warn("password reset email failed", errorNameAndCode(error));
          try {
            await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, id));
          } catch (cleanupError) {
            log?.warn("reset token cleanup failed", errorNameAndCode(cleanupError));
          }
        }
      }
      return { message: PASSWORD_RESET_REQUEST_MESSAGE };
    },

    async confirmReset(token, password) {
      await db.transaction(async (tx) => {
        // One conditional update, in database time: unused and unexpired. A reused,
        // expired, or fabricated token matches no row and changes nothing.
        const redeemed = await tx
          .update(passwordResetTokens)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(passwordResetTokens.tokenHash, tokenHash(token)),
              isNull(passwordResetTokens.usedAt),
              gt(passwordResetTokens.expiresAt, sql`now()`),
            ),
          )
          .returning({ humanId: passwordResetTokens.humanId });
        const [row] = redeemed;
        if (row === undefined) throw new RecoveryError("reset_token_invalid");
        await changePasswordAndSignOut(
          tx,
          accounts,
          row.humanId,
          password,
          "password_reset_completed",
        );
      });
      return { message: PASSWORD_RESET_CONFIRM_MESSAGE };
    },

    async localRecover(email, password) {
      // No SMTP, no token, no setup: the command's authority is local access to the
      // server plus the account being a system administrator (#20 story 10). An
      // ordinary account cannot use it as a public bypass, even with local access.
      // It changes only the account's password, its browser sessions, its outstanding
      // reset links, and one event — never bootstrap or a workspace owner.
      const recoveredEmail = await db.transaction(async (tx) => {
        const account = await accounts.accountByEmail(email, tx);
        if (account === null) throw new RecoveryError("account_not_found");
        if (!account.isSystemAdministrator) {
          throw new RecoveryError("not_system_administrator");
        }
        await changePasswordAndSignOut(
          tx,
          accounts,
          account.humanId,
          password,
          "local_recovery_completed",
        );
        return account.email;
      });
      return { email: recoveredEmail, message: LOCAL_RECOVERY_MESSAGE };
    },
  };
}
