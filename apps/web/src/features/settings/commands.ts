import { SessionResponse, SmtpSettingsResponse, TestEmailResponse } from "@orrery/contract";
import type { SmtpSettings, VerifyEmailRequest } from "@orrery/contract";
import { post, postJson, putJson } from "../../lib/api.ts";

// Mutations for this feature. Each goes through the app's one request helper, which
// parses the response with the contract's schemas and turns a Problem (RFC 9457) into an
// Error carrying its most specific human text, so the route can render it directly.

// Replaces the whole SMTP configuration. The stored password is never returned, so the
// caller must re-supply it; an explicit null clears an optional credential.
export function saveSmtpSettings(input: SmtpSettings): Promise<SmtpSettingsResponse> {
  return putJson("/api/settings/smtp", input, (value) => SmtpSettingsResponse.parse(value));
}

// Sends the verification email to the signed-in administrator's own address. Delivery
// failures answer as Problems whose code names the reason.
export function sendTestEmail(): Promise<TestEmailResponse> {
  return post("/api/settings/smtp/test", (value) => TestEmailResponse.parse(value));
}

// Redeems the single-use token from the test email. The response is the account with its
// verified state, so the caller can refresh the session cache.
export function verifyEmail(input: VerifyEmailRequest): Promise<SessionResponse> {
  return postJson("/api/settings/email-verification", input, (value) =>
    SessionResponse.parse(value),
  );
}
