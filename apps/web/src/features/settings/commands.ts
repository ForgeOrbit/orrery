import { SessionResponse, SmtpSettingsResponse, TestEmailResponse } from "@orrery/contract";
import type { SmtpSettings, VerifyEmailRequest } from "@orrery/contract";
import { post, postJson, putJson } from "../../lib/api.ts";

export function saveSmtpSettings(input: SmtpSettings): Promise<SmtpSettingsResponse> {
  return putJson("/api/settings/smtp", input, (value) => SmtpSettingsResponse.parse(value));
}

export function sendTestEmail(): Promise<TestEmailResponse> {
  return post("/api/settings/smtp/test", (value) => TestEmailResponse.parse(value));
}

export function verifyEmail(input: VerifyEmailRequest): Promise<SessionResponse> {
  return postJson("/api/settings/email-verification", input, (value) =>
    SessionResponse.parse(value),
  );
}
