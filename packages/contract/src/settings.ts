import { z } from "zod";
import { Email } from "./common.ts";







export const SmtpSecurity = z.enum(["none", "starttls", "tls"]).meta({ id: "SmtpSecurity" });
export type SmtpSecurity = z.infer<typeof SmtpSecurity>;






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





export const TestEmailResponse = z
  .object({
    sentTo: Email,
    message: z.string(),
  })
  .meta({ id: "TestEmailResponse" });
export type TestEmailResponse = z.infer<typeof TestEmailResponse>;




export const VerifyEmailRequest = z
  .object({
    token: z.string().min(1).max(1024),
  })
  .meta({ id: "VerifyEmailRequest" });
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;
