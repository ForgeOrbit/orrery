import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createTransport } from "nodemailer";
import type { SmtpSettings, SmtpSettingsResponse } from "@orrery/contract";
import type { SessionAccount } from "../accounts/index.ts";
import type { Logger } from "../../platform/log.ts";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { emailVerificationTokens, humans, instanceSettings } from "../../db/schema.ts";

// The service is the only file in a feature that decides anything. rest.ts calls it.

// One email the installation sends. The body is plain text on purpose: every recipient
// must be able to read it, and nothing in this ticket needs HTML.
export interface SmtpMail {
  from: string;
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
  | "smtp_unconfigured"
  | "verification_token_invalid"
  | "smtp_unreachable"
  | "smtp_auth_failed"
  | "smtp_tls_failed"
  | "smtp_send_failed";

// Each kind is the REST error's stable code and its message the Problem's title
// (ADR-0003), so clients branch on the code and people read the title.
const messages = {
  not_signed_in: "Not signed in.",
  not_admin: "Only a system administrator can manage installation settings.",
  smtp_unconfigured: "SMTP is not configured yet. Save the SMTP settings first.",
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

// The browser session cookie holds a random token; only its SHA-256 is stored, exactly
// like accounts' session tokens.
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SettingsDeps {
  db: PostgresJsDatabase;
  // The URL people use to reach the server; the verification email links into it.
  publicUrl: string;
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
}

// An error's code (ECONNREFUSED, EAUTH, ...), read without asserting a shape: errors
// arrive from drivers and libraries that each wrap them differently.
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

// What kind of failure a relay error is, without the error's own text: the kind names
// what to check, the log keeps the rest.
function deliveryFailureKind(error: unknown): SettingsErrorKind {
  const code = errorCode(error);
  if (code === "EAUTH") return "smtp_auth_failed";
  const message = error instanceof Error ? error.message : "";
  // nodemailer wraps low-level socket failures as ESOCKET, with the real cause in the
  // message ("connect ECONNREFUSED ..."), so look there before blaming TLS.
  if (
    /ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE/.test(
      message,
    )
  ) {
    return "smtp_unreachable";
  }
  if (
    (code !== undefined && (code === "ESOCKET" || code.startsWith("ERR_SSL"))) ||
    /SSL|TLS|certificate/i.test(message)
  ) {
    return "smtp_tls_failed";
  }
  if (
    code !== undefined &&
    /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ECONNECTION)$/.test(
      code,
    )
  ) {
    return "smtp_unreachable";
  }
  return "smtp_send_failed";
}

function errorNameAndCode(error: unknown): { error: string; code?: string } {
  const code = errorCode(error);
  return {
    error: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }),
  };
}

function verificationEmail(email: string, token: string, publicUrl: string): SmtpMail["text"] {
  return [
    `Confirm that ${email} belongs to you.`,
    "",
    "Single-use token, valid for 24 hours:",
    "",
    token,
    "",
    `Complete verification at ${publicUrl}/verify-email?token=${token}`,
    "Opening the link alone changes nothing; the token is only used when you confirm.",
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

export function createSettingsService({
  db,
  publicUrl,
  sendMail = sendWithSmtp,
  log,
}: SettingsDeps): SettingsService {
  return {
    async smtp(account) {
      requireAdministrator(account);
      const [row] = await db.select().from(instanceSettings).limit(1);
      if (row === undefined) {
        return {
          host: null,
          port: null,
          security: null,
          username: null,
          hasPassword: false,
          from: null,
        };
      }
      return {
        host: row.smtpHost,
        port: row.smtpPort,
        security: row.smtpSecurity,
        username: row.smtpUsername,
        hasPassword: row.smtpPassword !== null,
        from: row.smtpFrom,
      };
    },

    // Saves the complete configuration, password included, in one upsert on the
    // singleton row: concurrent saves settle on one row, last writer wins.
    async saveSmtp(account, input) {
      const admin = requireAdministrator(account);
      const saved = {
        smtpHost: input.host,
        smtpPort: input.port,
        smtpSecurity: input.security,
        smtpUsername: input.username,
        smtpPassword: input.password,
        smtpFrom: input.from,
        updatedAt: sql`now()`,
        updatedByHumanId: admin.humanId,
      };
      await db
        .insert(instanceSettings)
        .values({ id: true, ...saved })
        .onConflictDoUpdate({ target: instanceSettings.id, set: saved });
      return {
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        hasPassword: input.password !== null,
        from: input.from,
      };
    },

    // The test email doubles as the verification email (issue #22): it goes to the
    // administrator's own address and carries a fresh single-use token. Receiving it
    // proves both the delivery settings and ownership of the mailbox.
    async sendTestEmail(account) {
      const admin = requireAdministrator(account);
      const [row] = await db.select().from(instanceSettings).limit(1);
      if (row === undefined) throw new SettingsError("smtp_unconfigured");
      const settings: SmtpSettings = {
        host: row.smtpHost,
        port: row.smtpPort,
        security: row.smtpSecurity,
        username: row.smtpUsername,
        password: row.smtpPassword,
        from: row.smtpFrom,
      };

      const token = randomBytes(32).toString("base64url");
      await db.insert(emailVerificationTokens).values({
        id: randomUUID(),
        humanId: admin.humanId,
        tokenHash: tokenHash(token),
        expiresAt: sql`now() + make_interval(secs => ${VERIFICATION_TTL_SECONDS})`,
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
        // The log line carries the error's name and code only, which cannot contain
        // secrets; the administrator answers with the classified kind, never the raw
        // error text.
        log?.warn("test email failed", errorNameAndCode(error));
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
    // issued to another account is refused without being consumed.
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
        await tx
          .update(humans)
          .set({ emailVerifiedAt: sql`now()` })
          .where(eq(humans.id, row.humanId));
      });
      return { email: account.email, emailVerified: true as const };
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
