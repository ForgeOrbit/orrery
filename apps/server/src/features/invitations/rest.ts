import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  InstallationInvitation,
  InvitationRegistrationRequest,
  InviteInstallationRequest,
  SessionResponse,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { deliveryStatusFor, isDeliveryKind, SettingsError } from "../settings/index.ts";
import { InvitationsError, type InvitationsErrorKind, type InvitationsService } from "./service.ts";

const inviteInstallation = createRoute({
  method: "post",
  path: "/api/invitations/installation",
  summary: "Send an installation invitation",
  description:
    "System administrators only, after SMTP is configured. Emails the invited address a single-use registration link, valid for seven days. Following the link (GET) changes nothing; the recipient registers with a POST. One pending invitation per email. A delivery failure sends no link at all and answers a Problem whose code names the reason (smtp_unreachable, smtp_auth_failed, smtp_tls_failed, smtp_send_failed).",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: InviteInstallationRequest } },
    },
  },
  responses: {
    201: {
      description: "The invitation, pending",
      content: { "application/json": { schema: InstallationInvitation } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
    409: problem(
      "The email has an account or a pending invitation, or SMTP is not configured or its stored password is unreadable",
    ),
    502: problem("The SMTP server refused the message; the code says why"),
  },
});

const registerInstallation = createRoute({
  method: "post",
  path: "/api/invitations/installation/registration",
  summary: "Register through an installation invitation",
  description:
    "Redeems the token from the invitation email with the password the recipient chose, and creates the account bound to the invited email, its personal workspace, and the verified-email mark, in one transaction. Single-use: only this POST consumes the token; the link's GET changes nothing.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: InvitationRegistrationRequest } },
    },
  },
  responses: {
    200: {
      description: "The account, with its email verified",
      content: { "application/json": { schema: SessionResponse } },
    },
    400: problem("The token is invalid, expired, or already used"),
    409: problem("The invited email already has an account"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [inviteInstallation, registerInstallation];

// Transport details rest.ts owns: every invitations error kind's HTTP status. Delivery
// failures keep their settings codes and statuses through the shared map, so the reason
// says where the send failed, not which route asked for it.
const statusFor = {
  not_signed_in: 401,
  not_admin: 403,
  account_exists: 409,
  invitation_pending: 409,
  invitation_invalid: 400,
} as const satisfies Record<InvitationsErrorKind, number>;

// The kinds each route's service calls can throw: a route answers exactly these. The
// registration route sends no email, so only the invitations kinds apply there.
const inviteKinds = ["not_signed_in", "not_admin", "account_exists", "invitation_pending"] as const;
const registrationKinds = ["invitation_invalid", "account_exists"] as const;

// True when the error's kind is one of the route's kinds. A type guard is the honest
// way to narrow; no assertions.
function isKind<K extends readonly InvitationsErrorKind[]>(
  error: InvitationsError,
  kinds: K,
): error is InvitationsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

// Thin: resolve the session, call the service, map the result to HTTP. The service
// decides who may do what; this layer only carries it, and every error is a Problem
// built through platform/problem.ts (ADR-0003). A kind the route does not answer is a
// programming error: it stays a 500 instead of silently gaining a status.
export function createInvitationsRest(service: InvitationsService, sessionReader: SessionReader) {
  // Validation failures answer as a validation_failed Problem, like every other error.
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(inviteInstallation, async (c) => {
    try {
      return c.json(
        await service.inviteInstallation(await sessionReader(c), c.req.valid("json")),
        201,
      );
    } catch (error) {
      if (error instanceof InvitationsError && isKind(error, inviteKinds)) {
        return problemResponse(c, {
          status: statusFor[error.kind],
          code: error.kind,
          title: error.message,
        });
      }
      // The sending route also answers every delivery failure with settings' own code,
      // so a client can tell the reasons apart wherever the send happened.
      if (error instanceof SettingsError && isDeliveryKind(error)) {
        return problemResponse(c, {
          status: deliveryStatusFor[error.kind],
          code: error.kind,
          title: error.message,
        });
      }
      throw error;
    }
  });

  app.openapi(registerInstallation, async (c) => {
    try {
      return c.json(await service.registerInstallation(c.req.valid("json")), 200);
    } catch (error) {
      if (error instanceof InvitationsError && isKind(error, registrationKinds)) {
        return problemResponse(c, {
          status: statusFor[error.kind],
          code: error.kind,
          title: error.message,
        });
      }
      throw error;
    }
  });

  return app;
}
