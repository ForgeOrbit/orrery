import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  SessionResponse,
  SmtpSettings,
  SmtpSettingsResponse,
  TestEmailResponse,
  VerifyEmailRequest,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { SettingsError, type SettingsService } from "./service.ts";

const smtp = createRoute({
  method: "get",
  path: "/api/settings/smtp",
  summary: "The installation's SMTP settings, without the password",
  description:
    "System administrators only. Every field is null while SMTP has not been configured; hasPassword says whether a secret is stored without ever returning it.",
  responses: {
    200: {
      description: "The saved settings",
      content: { "application/json": { schema: SmtpSettingsResponse } },
    },
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
  },
});

const saveSmtp = createRoute({
  method: "put",
  path: "/api/settings/smtp",
  summary: "Replace the installation's SMTP settings",
  description:
    "System administrators only. Replaces the whole configuration, password included: the stored password is never returned, so an update supplies it again. An explicit null means no username or no password.",
  request: {
    body: { required: true, content: { "application/json": { schema: SmtpSettings } } },
  },
  responses: {
    200: {
      description: "The saved settings, without the password",
      content: { "application/json": { schema: SmtpSettingsResponse } },
    },
    400: problem("The settings are invalid"),
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
  },
});

const sendTestEmail = createRoute({
  method: "post",
  path: "/api/settings/smtp/test",
  summary: "Send a test email to the administrator's own address",
  description:
    "System administrators only, after SMTP is configured. The email carries a single-use token; redeeming it verifies the administrator's address. A delivery failure is a Problem whose code names the reason (smtp_unreachable, smtp_auth_failed, smtp_tls_failed, smtp_send_failed).",
  responses: {
    200: {
      description: "The test email was sent to the administrator's own address",
      content: { "application/json": { schema: TestEmailResponse } },
    },
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
    409: problem("SMTP is not configured yet"),
    502: problem("The SMTP server refused the message; the code says why"),
  },
});

const verifyEmail = createRoute({
  method: "post",
  path: "/api/settings/email-verification",
  summary: "Redeem the verification token from the test email",
  description:
    "For the signed-in account the token was issued to. The token is single-use and short-lived, and only this POST consumes it; opening the link in the email changes nothing.",
  request: {
    body: { required: true, content: { "application/json": { schema: VerifyEmailRequest } } },
  },
  responses: {
    200: {
      description: "The account, with its email verified",
      content: { "application/json": { schema: SessionResponse } },
    },
    400: problem("The token is invalid, expired, already used, or issued to another account"),
    401: problem("Not signed in"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [smtp, saveSmtp, sendTestEmail, verifyEmail];

// Each route answers exactly the SettingsError kinds its service call can throw, at the
// status its route declares. Any other kind is a programming error: it stays a 500
// instead of silently gaining a status.
const sessionStatus = (error: SettingsError): 401 | 403 | undefined =>
  error.kind === "not_signed_in" ? 401 : error.kind === "not_admin" ? 403 : undefined;
const testStatus = (error: SettingsError): 401 | 403 | 409 | 502 | undefined =>
  error.kind === "not_signed_in"
    ? 401
    : error.kind === "not_admin"
      ? 403
      : error.kind === "smtp_unconfigured"
        ? 409
        : error.kind === "smtp_unreachable" ||
            error.kind === "smtp_auth_failed" ||
            error.kind === "smtp_tls_failed" ||
            error.kind === "smtp_send_failed"
          ? 502
          : undefined;
const verifyStatus = (error: SettingsError): 401 | 400 | undefined =>
  error.kind === "not_signed_in"
    ? 401
    : error.kind === "verification_token_invalid"
      ? 400
      : undefined;

// Thin: resolve the session, call the service, map the result to HTTP. The service
// decides who may do what; this layer only carries it. Every error is a Problem whose
// code is the service error's kind and whose title is its message (ADR-0003).
export function createSettingsRest(service: SettingsService, sessionReader: SessionReader) {
  // Validation failures answer as a validation_failed Problem, like every other error.
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(smtp, async (c) => {
    try {
      return c.json(await service.smtp(await sessionReader(c)), 200);
    } catch (error) {
      if (error instanceof SettingsError) {
        const status = sessionStatus(error);
        if (status !== undefined) {
          return problemResponse(c, { status, code: error.kind, title: error.message });
        }
      }
      throw error;
    }
  });

  app.openapi(saveSmtp, async (c) => {
    try {
      return c.json(await service.saveSmtp(await sessionReader(c), c.req.valid("json")), 200);
    } catch (error) {
      if (error instanceof SettingsError) {
        const status = sessionStatus(error);
        if (status !== undefined) {
          return problemResponse(c, { status, code: error.kind, title: error.message });
        }
      }
      throw error;
    }
  });

  app.openapi(sendTestEmail, async (c) => {
    try {
      return c.json(await service.sendTestEmail(await sessionReader(c)), 200);
    } catch (error) {
      if (error instanceof SettingsError) {
        const status = testStatus(error);
        if (status !== undefined) {
          return problemResponse(c, { status, code: error.kind, title: error.message });
        }
      }
      throw error;
    }
  });

  app.openapi(verifyEmail, async (c) => {
    try {
      return c.json(await service.verifyEmail(await sessionReader(c), c.req.valid("json")), 200);
    } catch (error) {
      if (error instanceof SettingsError) {
        const status = verifyStatus(error);
        if (status !== undefined) {
          return problemResponse(c, { status, code: error.kind, title: error.message });
        }
      }
      throw error;
    }
  });

  return app;
}
