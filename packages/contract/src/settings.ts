import { z } from "zod";
import { Email } from "./common.ts";

// Instance settings (issue #22): the system administrator configures SMTP through the
// app after bootstrap, so email setup never blocks first login (ADR-0001). The settings
// persist in the database; deployment essentials stay in environment variables.

// How Orrery connects to the SMTP server: plain, an explicit STARTTLS upgrade, or TLS
// from the first byte. The mode is a setting, not a guess from the port.
export const SmtpSecurity = z.enum(["none", "starttls", "tls"]).meta({ id: "SmtpSecurity" });
export type SmtpSecurity = z.infer<typeof SmtpSecurity>;

// The complete SMTP configuration, as saved by a system administrator. This replaces
// the stored settings wholesale, password included: the password is a secret that is
// never returned, so an update must re-supply it. Null means "no username" / "no
// password", and the two are independent on purpose: some relays authenticate with a
// username and an empty password.
export const SmtpSettings = z
  .object({
    host: z.string().min(1, "Set the SMTP host.").max(255),
    port: z.number().int().min(1).max(65535),
    security: SmtpSecurity,
    username: z.string().max(255).nullable(),
    password: z.string().min(1).max(1024).nullable(),
    from: Email,
  })
  .meta({ id: "SmtpSettings" });
export type SmtpSettings = z.infer<typeof SmtpSettings>;

// The saved settings as they can be read back: without the password, but with whether
// one is stored. Every field is null while SMTP has not been configured yet, so an unset
// state needs no second schema.
export const SmtpSettingsResponse = z
  .object({
    host: z.string().nullable(),
    port: z.number().int().nullable(),
    security: SmtpSecurity.nullable(),
    username: z.string().nullable(),
    hasPassword: z.boolean(),
    from: z.string().nullable(),
  })
  .meta({ id: "SmtpSettingsResponse" });
export type SmtpSettingsResponse = z.infer<typeof SmtpSettingsResponse>;

// The successful test send: the mailbox it went to, and what to do next. A failed send
// is not this resource — it answers as a Problem whose code says why (smtp_unreachable,
// smtp_auth_failed, smtp_tls_failed, smtp_send_failed), so a client can tell the
// reasons apart without parsing prose.
export const TestEmailResponse = z
  .object({
    sentTo: Email,
    message: z.string(),
  })
  .meta({ id: "TestEmailResponse" });
export type TestEmailResponse = z.infer<typeof TestEmailResponse>;

// Redeems the single-use token from the test email. The token is only ever used by a
// POST; following a link (GET) changes nothing. The response is the account, with its
// email now verified.
export const VerifyEmailRequest = z
  .object({
    token: z.string().min(1).max(1024),
  })
  .meta({ id: "VerifyEmailRequest" });
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;
