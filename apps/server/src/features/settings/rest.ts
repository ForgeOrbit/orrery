import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  SessionResponse,
  SmtpSettings,
  SmtpSettingsResponse,
  TestEmailResponse,
  VerifyEmailRequest,
} from "@orrery/contract";
import type { Context } from "hono";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import {
  isDeliveryKind,
  SettingsError,
  type DeliveryErrorKind,
  type SettingsErrorKind,
  type SettingsService,
} from "./service.ts";

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
    "System administrators only. Replaces the whole configuration, password included: the stored password is never returned, so an update supplies it again, and it is stored encrypted at rest (ADR-0004). An explicit null means no username or no password. Security 'none' refuses credentials, and a password requires the deployment's encryption key.",
  request: {
    body: { required: true, content: { "application/json": { schema: SmtpSettings } } },
  },
  responses: {
    200: {
      description: "The saved settings, without the password",
      content: { "application/json": { schema: SmtpSettingsResponse } },
    },
    400: problem("The settings are invalid, or security 'none' carries credentials"),
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
    409: problem("No encryption key is configured for a password"),
  },
});

const sendTestEmail = createRoute({
  method: "post",
  path: "/api/settings/smtp/test",
  summary: "Send a test email to the administrator's own address",
  description:
    "System administrators only, after SMTP is configured. The email carries a single-use token; redeeming it verifies the administrator's address. A delivery failure is a Problem whose code names the reason (smtp_unreachable, smtp_auth_failed, smtp_tls_failed, smtp_send_failed); a stored password the key cannot read is 409 smtp_password_unreadable.",
  responses: {
    200: {
      description: "The test email was sent to the administrator's own address",
      content: { "application/json": { schema: TestEmailResponse } },
    },
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
    409: problem(
      "SMTP is not configured, or its stored password cannot be read with the configured key",
    ),
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

// Every non-delivery error kind's HTTP status. Delivery statuses come from the one
// shared map (deliveryStatusFor), so the codes and statuses mean the same wherever a
// send happens. An unreadable stored password is 409, not 502: it comes from this
// server's own key setup, and the administrator fixes it by re-entering the password.
const statusFor = {
  not_signed_in: 401,
  not_admin: 403,
  insecure_smtp_credentials: 400,
  encryption_key_missing: 409,
  verification_token_invalid: 400,
} as const satisfies Record<Exclude<SettingsErrorKind, DeliveryErrorKind>, number>;

// Every delivery kind's HTTP status, wherever the send happened: one map, because the
// codes mean the same thing on every route that sends mail. The service classifies the
// failure; this layer alone decides its status.
const deliveryStatusFor = {
  smtp_unconfigured: 409,
  smtp_password_unreadable: 409,
  smtp_unreachable: 502,
  smtp_auth_failed: 502,
  smtp_tls_failed: 502,
  smtp_send_failed: 502,
} as const satisfies Record<DeliveryErrorKind, number>;

// A delivery failure as its Problem, or undefined when the error is not one. Exported
// through settings/index.ts, so a feature that borrows the mail path answers the same
// codes at the same statuses without importing this file.
export function deliveryProblem(c: Context, error: unknown) {
  if (error instanceof SettingsError && isDeliveryKind(error)) {
    return problemResponse(c, {
      status: deliveryStatusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  return undefined;
}

// The kinds each route's service calls can throw: a route answers exactly these. The
// sending route's delivery kinds are answered through the shared guard, not listed here.
const sessionKinds = ["not_signed_in", "not_admin"] as const;
const saveKinds = [
  "not_signed_in",
  "not_admin",
  "insecure_smtp_credentials",
  "encryption_key_missing",
] as const;
const testKinds = ["not_signed_in", "not_admin"] as const;
const verifyKinds = ["not_signed_in", "verification_token_invalid"] as const;

// True when the error's kind is one of the route's kinds. A type guard is the honest
// way to narrow; no assertions.
function isKind<K extends readonly Exclude<SettingsErrorKind, DeliveryErrorKind>[]>(
  error: SettingsError,
  kinds: K,
): error is SettingsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

// Every route's error answer in one place: a Problem for the kinds the route declares,
// at that kind's status. A kind the route does not answer is a programming error: it
// stays a 500 instead of silently gaining a status.
function failure<K extends readonly Exclude<SettingsErrorKind, DeliveryErrorKind>[]>(
  c: Context,
  error: unknown,
  kinds: K,
) {
  if (error instanceof SettingsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

// The sending route additionally answers every delivery failure with its shared code
// and status, so a client can tell the reasons apart wherever the send happened.
function failureWithDelivery<K extends readonly Exclude<SettingsErrorKind, DeliveryErrorKind>[]>(
  c: Context,
  error: unknown,
  kinds: K,
) {
  return deliveryProblem(c, error) ?? failure(c, error, kinds);
}

// Thin: resolve the session, call the service, map the result to HTTP. The service
// decides who may do what; this layer only carries it, and every error is a Problem
// built through platform/problem.ts (ADR-0003).
export function createSettingsRest(service: SettingsService, sessionReader: SessionReader) {
  // Validation failures answer as a validation_failed Problem, like every other error.
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(smtp, async (c) => {
    try {
      return c.json(await service.smtp(await sessionReader(c)), 200);
    } catch (error) {
      return failure(c, error, sessionKinds);
    }
  });

  app.openapi(saveSmtp, async (c) => {
    try {
      return c.json(await service.saveSmtp(await sessionReader(c), c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error, saveKinds);
    }
  });

  app.openapi(sendTestEmail, async (c) => {
    try {
      return c.json(await service.sendTestEmail(await sessionReader(c)), 200);
    } catch (error) {
      return failureWithDelivery(c, error, testKinds);
    }
  });

  app.openapi(verifyEmail, async (c) => {
    try {
      return c.json(await service.verifyEmail(await sessionReader(c), c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error, verifyKinds);
    }
  });

  return app;
}
