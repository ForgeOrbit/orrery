import { randomBytes, randomUUID } from "node:crypto";
import { createTransport } from "nodemailer";
import type { SmtpSecurity, SmtpSettings, SmtpSettingsResponse } from "@orrery/contract";
import type { SessionAccount } from "../accounts/index.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { emailVerificationTokens, instanceSettings } from "../../db/schema.ts";
import { decryptSecret, encryptSecret } from "../../platform/secrets.ts";

// The service is the only file in a feature that decides anything. rest.ts calls it.

// One email the installation sends. The body is plain text on purpose: every recipient
// must be able to read it, and nothing in this ticket needs HTML.
export interface SmtpMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

// One email another feature asks the installation to send (issue #23's invitations
// first): the caller decides the recipient and the content; settings owns the transport
// and supplies the configured From address.
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

// Sends one email through the given settings, or throws. Injectable so tests can prove
// the flow's decisions without a real relay; the e2e suite sends real mail through
// Mailpit to prove the transport itself.
export type SmtpSender = (settings: SmtpSettings, mail: SmtpMail) => Promise<void>;

export type SettingsErrorKind =
  | "not_signed_in"
  | "not_admin"
  | "insecure_smtp_credentials"
  | "encryption_key_missing"
  | "smtp_unconfigured"
  | "smtp_password_unreadable"
  | "verification_token_invalid"
  | "smtp_unreachable"
  | "smtp_auth_failed"
  | "smtp_tls_failed"
  | "smtp_send_failed";

// The kinds a delivery through the configured relay can answer with: every feature that
// borrows the mail path (invitations now, recovery and input later) declares the same
// codes for its own send routes, so a client can tell the reasons apart wherever the
// send happened.
export type DeliveryErrorKind = Extract<
  SettingsErrorKind,
  | "smtp_unconfigured"
  | "smtp_password_unreadable"
  | "smtp_unreachable"
  | "smtp_auth_failed"
  | "smtp_tls_failed"
  | "smtp_send_failed"
>;

// The delivery kinds, as one list the guard checks against.
const deliveryKinds = [
  "smtp_unconfigured",
  "smtp_password_unreadable",
  "smtp_unreachable",
  "smtp_auth_failed",
  "smtp_tls_failed",
  "smtp_send_failed",
] as const satisfies readonly DeliveryErrorKind[];

// True when the error is one of the delivery kinds. A type guard is the honest way to
// narrow; no assertions.
export function isDeliveryKind(error: SettingsError): error is SettingsError & {
  kind: DeliveryErrorKind;
} {
  return deliveryKinds.some((kind) => kind === error.kind);
}

// Each kind is the REST error's stable code and its message the Problem's title
// (ADR-0003), so clients branch on the code and people read the title.
const messages = {
  not_signed_in: "Not signed in.",
  not_admin: "Only a system administrator can manage installation settings.",
  insecure_smtp_credentials:
    "SMTP security 'none' sends the username and password in clear text. Choose starttls or tls, or save no credentials.",
  encryption_key_missing:
    "No encryption key is configured, so a password cannot be saved. Set ORRERY_ENCRYPTION_KEY on the server and try again.",
  smtp_unconfigured: "SMTP is not configured yet. Save the SMTP settings first.",
  smtp_password_unreadable:
    "The stored SMTP password cannot be read with the server's encryption key. Re-enter the password in the settings.",
  verification_token_invalid: "This verification token is invalid, expired, or already used.",
  smtp_unreachable:
    "Could not reach the SMTP server. Check the host and port, and that the server accepts connections from this Orrery server.",
  smtp_auth_failed: "The SMTP server rejected the username or password. Check them and try again.",
  smtp_tls_failed:
    "The TLS connection failed. Check that the security setting (starttls or tls) matches the server, and that its certificate is valid.",
  smtp_send_failed: "The SMTP server did not accept the message. Check the settings and try again.",
} as const satisfies Record<SettingsErrorKind, string>;

export class SettingsError extends Error {
  readonly kind: SettingsErrorKind;

  constructor(kind: SettingsErrorKind) {
    super(messages[kind]);
    this.name = "SettingsError";
    this.kind = kind;
  }
}

// How long a verification token lives. An implementation default, not a product mode:
// the token exists to be redeemed minutes after the test email arrives.
const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

export interface SettingsDeps {
  db: PostgresJsDatabase;
  // The URL people use to reach the server; the verification email names its API.
  publicUrl: string;
  // The deployment's key for secrets at rest (ADR-0004). Undefined means none is set:
  // a password cannot be saved, and a stored one cannot be sent.
  encryptionKey: Buffer | undefined;
  // Accounts owns the humans table; a redeemed token earns this write.
  markEmailVerified: (humanId: string, tx: DbTransaction) => Promise<void>;
  // Sends the mail. Falls back to the real SMTP transport when omitted.
  sendMail?: SmtpSender;
  log?: Logger;
}

export interface SettingsService {
  smtp(account: SessionAccount | null): Promise<SmtpSettingsResponse>;
  saveSmtp(account: SessionAccount | null, input: SmtpSettings): Promise<SmtpSettingsResponse>;
  sendTestEmail(account: SessionAccount | null): Promise<{ sentTo: string; message: string }>;
  verifyEmail(
    account: SessionAccount | null,
    input: { token: string },
  ): Promise<{ email: string; emailVerified: true }>;
  // Sends one email through the configured relay, with the stored From address: the one
  // mail path other features borrow, so no second transport exists anywhere.
  deliver(mail: OutgoingMail): Promise<void>;
}

// One row of the settings table as every reader needs it, mapped once: the secret stays
// encrypted, and the response says only whether one is stored.
interface StoredSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  passwordEncrypted: string | null;
  from: string;
}

function toSettings(row: typeof instanceSettings.$inferSelect): StoredSettings {
  return {
    host: row.smtpHost,
    port: row.smtpPort,
    security: row.smtpSecurity,
    username: row.smtpUsername,
    passwordEncrypted: row.smtpPasswordEncrypted,
    from: row.smtpFrom,
  };
}

function toResponse(stored: StoredSettings): SmtpSettingsResponse {
  return {
    host: stored.host,
    port: stored.port,
    security: stored.security,
    username: stored.username,
    hasPassword: stored.passwordEncrypted !== null,
    from: stored.from,
  };
}

// The settings as the sender needs them: the password decrypted for this send only,
// never stored or logged again.
function toSmtpSettings(stored: StoredSettings, password: string | null): SmtpSettings {
  return {
    host: stored.host,
    port: stored.port,
    security: stored.security,
    username: stored.username,
    password,
    from: stored.from,
  };
}

// The response while nothing is saved: every field unset.
const UNSET_RESPONSE: SmtpSettingsResponse = {
  host: null,
  port: null,
  security: null,
  username: null,
  hasPassword: false,
  from: null,
};

// The socket-level causes that make a relay unreachable, as one list for both checks:
// nodemailer wraps them as ESOCKET with the cause in the message, and other callers
// surface them as the error's own code.
const UNREACHABLE_CODES =
  /ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ECONNECTION/;

// What kind of failure a relay error is, without the error's own text: the kind names
// what to check, the log keeps the rest.
function deliveryFailureKind(error: unknown): SettingsErrorKind {
  // errorNameAndCode reads the error's code without asserting a shape: errors arrive
  // from drivers and libraries that each wrap them differently.
  const { code } = errorNameAndCode(error);
  if (code === "EAUTH") return "smtp_auth_failed";
  const message = error instanceof Error ? error.message : "";
  if (UNREACHABLE_CODES.test(message)) return "smtp_unreachable";
  if (code !== undefined && UNREACHABLE_CODES.test(code)) return "smtp_unreachable";
  // TLS only when the failure is clearly TLS: node's own SSL error codes, or a
  // certificate, handshake, or SSL/TLS message from the exchange itself.
  if (
    (code !== undefined && code.startsWith("ERR_SSL")) ||
    /SSL|TLS|certificate|handshake/i.test(message)
  ) {
    return "smtp_tls_failed";
  }
  return "smtp_send_failed";
}

function verificationEmail(email: string, token: string, publicUrl: string): SmtpMail["text"] {
  return [
    `Confirm that ${email} belongs to you.`,
    "",
    "Single-use token, valid for 24 hours:",
    "",
    token,
    "",
    `Sign in, then redeem it with a POST to ${publicUrl}/api/settings/email-verification to finish verification.`,
    "Nothing completes this until that POST; the token is only used when you do.",
    "",
    "If you did not expect this email, ignore it.",
  ].join("\n");
}

// Installation settings are administrator-only (issue #22): no session is 401, an
// ordinary account is 403. The one authorization rule of this feature, stated once.
function requireAdministrator(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new SettingsError("not_signed_in");
  if (!account.isSystemAdministrator) throw new SettingsError("not_admin");
  return account;
}

// The stored password decrypted for one send, or the reason it cannot be.
function storedPassword(stored: StoredSettings, key: Buffer | undefined): string | null {
  if (stored.passwordEncrypted === null) return null;
  if (key === undefined) throw new SettingsError("smtp_password_unreadable");
  const password = decryptSecret(key, stored.passwordEncrypted);
  if (password === undefined) throw new SettingsError("smtp_password_unreadable");
  return password;
}

export function createSettingsService({
  db,
  publicUrl,
  encryptionKey,
  markEmailVerified,
  sendMail = sendWithSmtp,
  log,
}: SettingsDeps): SettingsService {
  return {
    async smtp(account) {
      requireAdministrator(account);
      const [row] = await db.select().from(instanceSettings).limit(1);
      return row === undefined ? UNSET_RESPONSE : toResponse(toSettings(row));
    },

    // Saves the complete configuration in one upsert on the singleton row: concurrent
    // saves settle on one row, last writer wins. A password is encrypted at rest with
    // the deployment's key (ADR-0004) and never stored in the clear.
    async saveSmtp(account, input) {
      const admin = requireAdministrator(account);
      // Security "none" together with credentials would authenticate in clear text;
      // refuse the combination rather than send a usable password unprotected.
      if (input.security === "none" && (input.username !== null || input.password !== null)) {
        throw new SettingsError("insecure_smtp_credentials");
      }
      if (input.password !== null && encryptionKey === undefined) {
        throw new SettingsError("encryption_key_missing");
      }
      const encrypted =
        input.password === null || encryptionKey === undefined
          ? null
          : encryptSecret(encryptionKey, input.password);
      const stored: StoredSettings = {
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        passwordEncrypted: encrypted,
        from: input.from,
      };
      await db
        .insert(instanceSettings)
        .values({
          id: true,
          smtpHost: stored.host,
          smtpPort: stored.port,
          smtpSecurity: stored.security,
          smtpUsername: stored.username,
          smtpPasswordEncrypted: stored.passwordEncrypted,
          smtpFrom: stored.from,
          updatedAt: sql`now()`,
          updatedByHumanId: admin.humanId,
        })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: {
            smtpHost: stored.host,
            smtpPort: stored.port,
            smtpSecurity: stored.security,
            smtpUsername: stored.username,
            smtpPasswordEncrypted: stored.passwordEncrypted,
            smtpFrom: stored.from,
            updatedAt: sql`now()`,
            updatedByHumanId: admin.humanId,
          },
        });
      return toResponse(stored);
    },

    // The test email doubles as the verification email (issue #22): it goes to the
    // administrator's own address and carries a fresh single-use token. Receiving it
    // proves both the delivery settings and ownership of the mailbox. Issuing the
    // token invalidates the account's earlier unused tokens, and a send that fails
    // leaves no live token behind: one that was never delivered must not redeem.
    async sendTestEmail(account) {
      const admin = requireAdministrator(account);
      const [row] = await db.select().from(instanceSettings).limit(1);
      if (row === undefined) throw new SettingsError("smtp_unconfigured");
      const stored = toSettings(row);
      const settings = toSmtpSettings(stored, storedPassword(stored, encryptionKey));

      const token = randomBytes(32).toString("base64url");
      await db.transaction(async (tx) => {
        await tx
          .delete(emailVerificationTokens)
          .where(
            and(
              eq(emailVerificationTokens.humanId, admin.humanId),
              isNull(emailVerificationTokens.usedAt),
            ),
          );
        await tx.insert(emailVerificationTokens).values({
          id: randomUUID(),
          humanId: admin.humanId,
          tokenHash: tokenHash(token),
          expiresAt: sql`now() + make_interval(secs => ${VERIFICATION_TTL_SECONDS})`,
        });
      });
      const mail: SmtpMail = {
        from: settings.from,
        to: admin.email,
        subject: "Verify your Orrery email",
        text: verificationEmail(admin.email, token, publicUrl),
      };

      try {
        await sendMail(settings, mail);
      } catch (error) {
        log?.warn("test email failed", errorNameAndCode(error));
        // The email never left, so its token must not be redeemable. If even that
        // cleanup fails, the delivery answer still goes out: the log keeps the failed
        // cleanup's name and code only, never its message.
        try {
          await db
            .delete(emailVerificationTokens)
            .where(eq(emailVerificationTokens.tokenHash, tokenHash(token)));
        } catch (cleanupError) {
          log?.warn("token cleanup after a failed send failed", errorNameAndCode(cleanupError));
        }
        throw new SettingsError(deliveryFailureKind(error));
      }
      return {
        sentTo: admin.email,
        message:
          "The email contains a single-use token. Redeem it to finish verifying this address.",
      };
    },

    // One conditional update, evaluated in database time: the token must be unused and
    // unexpired. The redemption and the verified mark share one transaction, and a token
    // issued to another account is refused without being consumed. Accounts owns the
    // humans write, inside this transaction.
    async verifyEmail(account, input) {
      if (account === null) throw new SettingsError("not_signed_in");
      await db.transaction(async (tx) => {
        const rows = await tx
          .update(emailVerificationTokens)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(emailVerificationTokens.tokenHash, tokenHash(input.token)),
              isNull(emailVerificationTokens.usedAt),
              gt(emailVerificationTokens.expiresAt, sql`now()`),
            ),
          )
          .returning({ humanId: emailVerificationTokens.humanId });
        const [row] = rows;
        if (row === undefined || row.humanId !== account.humanId) {
          throw new SettingsError("verification_token_invalid");
        }
        await markEmailVerified(row.humanId, tx);
      });
      return { email: account.email, emailVerified: true as const };
    },

    // The one mail path other features borrow: the stored settings decide the relay and
    // the From address, the caller decides the content. Answers the delivery Problems
    // by code, exactly like sendTestEmail, so callers and clients tell the reasons
    // apart wherever the send happened.
    async deliver(mail) {
      const [row] = await db.select().from(instanceSettings).limit(1);
      if (row === undefined) throw new SettingsError("smtp_unconfigured");
      const stored = toSettings(row);
      const settings = toSmtpSettings(stored, storedPassword(stored, encryptionKey));
      try {
        await sendMail(settings, { from: settings.from, ...mail });
      } catch (error) {
        log?.warn("mail delivery failed", errorNameAndCode(error));
        throw new SettingsError(deliveryFailureKind(error));
      }
    },
  };
}

// The real transport. Built per send, so a settings change applies immediately and a
// broken relay never poisons a cached connection; email volume in this milestone is a
// few administrator messages, not a mail stream. Timeouts keep a dead relay from
// holding a request forever.
export const sendWithSmtp: SmtpSender = async (settings, mail) => {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    // The security mode is a deliberate setting, never a guess from the port: "tls"
    // connects with TLS from the first byte, "starttls" requires the upgrade and
    // refuses a silent downgrade, "none" stays plaintext.
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    auth:
      settings.username === null
        ? undefined
        : { user: settings.username, pass: settings.password ?? "" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: settings.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  } finally {
    transport.close();
  }
};

// The one startup warning settings owns: a stored SMTP password that no key can read is
// silently unusable, and the operator should learn that at startup, not at the first
// failed send. main.ts reports whatever this returns; the decision stays here.
export async function startupWarnings({
  db,
  encryptionKey,
}: Pick<SettingsDeps, "db" | "encryptionKey">): Promise<string[]> {
  if (encryptionKey !== undefined) return [];
  const [row] = await db
    .select({ passwordEncrypted: instanceSettings.smtpPasswordEncrypted })
    .from(instanceSettings)
    .limit(1);
  return row?.passwordEncrypted != null
    ? ["an SMTP password is stored but ORRERY_ENCRYPTION_KEY is not set, so it cannot be sent"]
    : [];
}
