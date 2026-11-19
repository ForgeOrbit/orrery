import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  DeclineInvitationRequest,
  InstallationInvitation,
  InvitationRegistrationRequest,
  InvitationSummaries,
  InvitationSummary,
  InviteInstallationRequest,
  SessionResponse,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { deliveryProblem } from "../settings/index.ts";
import { InvitationsError, type InvitationsErrorKind, type InvitationsService } from "./service.ts";

const inviteInstallation = createRoute({
  method: "post",
  path: "/api/invitations/installation",
  summary: "Send an installation invitation",
  description:
    "System administrators only, after SMTP is configured. Emails the invited address a single-use registration link, valid for seven days. Following the link (GET) changes nothing; the recipient registers with a POST. One pending invitation per email; re-inviting supersedes an expired, delivery-failed, or long-undelivered one in place. An invitation whose delivery is unknown may still redeem — holding the token proves the email arrived — and only a recorded failure never redeems. Answers 400 validation_failed; 401 not_signed_in; 403 not_admin; 409 account_exists, invitation_pending, smtp_unconfigured, or smtp_password_unreadable; and 502 smtp_unreachable, smtp_auth_failed, smtp_tls_failed, or smtp_send_failed.",
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

const invitationParams = z.object({ invitationId: z.string().min(1).max(200) });

const listInstallationInvitations = createRoute({
  method: "get",
  path: "/api/invitations/installation",
  summary: "List installation invitations",
  description:
    "System administrators only. Every installation invitation, newest first, with recipient, inviter, target, offered grants, lifecycle timestamps, and email delivery as a separate fact. A pending invitation whose seven days have passed is reported and stored as expired. The token never appears.",
  responses: {
    200: {
      description: "The installation invitations",
      content: { "application/json": { schema: InvitationSummaries } },
    },
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
  },
});

const resendInstallationInvitation = createRoute({
  method: "post",
  path: "/api/invitations/installation/{invitationId}/resend",
  summary: "Resend an installation invitation",
  description:
    "System administrators only. Rotates the link: a still-live pending invitation becomes revoked at replacement time, one past its deadline becomes expired at the deadline it passed, and a new pending invitation with a fresh seven-day deadline keeps the history. The previous link stops working. A delivery failure is recorded on the new invitation and answered as a delivery Problem; the invitation's lifecycle stays pending. Answers 409 invitation_not_pending when the invitation is accepted, declined, or revoked; invitation_pending when a concurrent invitation already owns the address; smtp_unconfigured when SMTP is missing; and smtp_password_unreadable when the stored password cannot be read. Answers 502 smtp_unreachable, smtp_auth_failed, smtp_tls_failed, or smtp_send_failed when the relay refuses the message.",
  request: { params: invitationParams },
  responses: {
    200: {
      description: "The new pending invitation, with its delivery recorded",
      content: { "application/json": { schema: InvitationSummary } },
    },
    400: problem("The invitation id is invalid"),
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
    404: problem("No invitation with this id"),
    409: problem(
      "The invitation is accepted, declined, or revoked; the recipient already has an account; another invitation for this address is already pending; or SMTP is not configured or its stored password is unreadable",
    ),
    502: problem("The SMTP server refused the message; the code says why"),
  },
});

const revokeInstallationInvitation = createRoute({
  method: "post",
  path: "/api/invitations/installation/{invitationId}/revoke",
  summary: "Revoke an installation invitation",
  description:
    "System administrators only. Only a pending, unexpired invitation is revoked; the link stops working and the row keeps its history and revocation timestamp.",
  request: { params: invitationParams },
  responses: {
    200: {
      description: "The revoked invitation",
      content: { "application/json": { schema: InvitationSummary } },
    },
    400: problem("The invitation id is invalid"),
    401: problem("Not signed in"),
    403: problem("Signed in, but not a system administrator"),
    404: problem("No invitation with this id"),
    409: problem("The invitation is no longer pending and unexpired"),
  },
});

const declineInstallationInvitation = createRoute({
  method: "post",
  path: "/api/invitations/installation/decline",
  summary: "Decline an installation invitation",
  description:
    "The recipient declines from the emailed link. Holding the token is the capability; only a pending, unexpired invitation without failed delivery changes, and its link then stops working.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: DeclineInvitationRequest } },
    },
  },
  responses: {
    204: { description: "The invitation was declined" },
    400: problem("The token is invalid, expired, or already used"),
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
    403: problem("The inviter is no longer a system administrator"),
    409: problem("The invited email already has an account"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [
  inviteInstallation,
  listInstallationInvitations,
  resendInstallationInvitation,
  revokeInstallationInvitation,
  declineInstallationInvitation,
  registerInstallation,
];

// Transport details rest.ts owns: every invitations error kind's HTTP status. Delivery
// failures keep their settings codes and statuses through the shared map, so the reason
// says where the send failed, not which route asked for it.
// Transport details rest.ts owns: every invitations error kind's HTTP status. Delivery
// failures keep their settings codes and statuses through the shared map, so the reason
// says where the send failed, not which route asked for it.
const statusFor = {
  not_signed_in: 401,
  not_admin: 403,
  account_exists: 409,
  invitation_pending: 409,
  invitation_invalid: 400,
  invitation_not_found: 404,
  invitation_not_pending: 409,
  inviter_not_authorized: 403,
} as const satisfies Record<InvitationsErrorKind, number>;

// The kinds each route's service calls can throw: a route answers exactly these.
const inviteKinds = ["not_signed_in", "not_admin", "account_exists", "invitation_pending"] as const;
const listKinds = ["not_signed_in", "not_admin"] as const;
const resendKinds = [
  "not_signed_in",
  "not_admin",
  "invitation_not_found",
  "invitation_not_pending",
  "invitation_pending",
  "account_exists",
] as const;
const revokeKinds = [
  "not_signed_in",
  "not_admin",
  "invitation_not_found",
  "invitation_not_pending",
] as const;
const declineKinds = ["invitation_invalid"] as const;
const registrationKinds = [
  "invitation_invalid",
  "inviter_not_authorized",
  "account_exists",
] as const;

// True when the error's kind is one of the route's kinds. A type guard is the honest
// way to narrow; no assertions.
function isKind<K extends readonly InvitationsErrorKind[]>(
  error: InvitationsError,
  kinds: K,
): error is InvitationsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

// Map the invitation kinds a route answers to their Problem. Undefined means the error
// is not one of them; the caller decides whether another mapper owns it.
function invitationFailure<K extends readonly InvitationsErrorKind[]>(
  c: Context,
  error: unknown,
  kinds: K,
) {
  if (error instanceof InvitationsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  return undefined;
}

function failure<K extends readonly InvitationsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  const invitation = invitationFailure(c, error, kinds);
  if (invitation !== undefined) return invitation;
  throw error;
}

// The sending routes also answer every delivery failure with settings' own code and
// status, so a client can tell the reasons apart wherever the send happened.
function sendFailure<K extends readonly InvitationsErrorKind[]>(
  c: Context,
  error: unknown,
  kinds: K,
) {
  const invitation = invitationFailure(c, error, kinds);
  if (invitation !== undefined) return invitation;
  const delivery = deliveryProblem(c, error);
  if (delivery !== undefined) return delivery;
  throw error;
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
      return sendFailure(c, error, inviteKinds);
    }
  });

  app.openapi(listInstallationInvitations, async (c) => {
    try {
      return c.json(await service.listInstallation(await sessionReader(c)), 200);
    } catch (error) {
      return failure(c, error, listKinds);
    }
  });

  app.openapi(resendInstallationInvitation, async (c) => {
    try {
      return c.json(
        await service.resendInstallation(await sessionReader(c), c.req.valid("param").invitationId),
        200,
      );
    } catch (error) {
      return sendFailure(c, error, resendKinds);
    }
  });

  app.openapi(revokeInstallationInvitation, async (c) => {
    try {
      return c.json(
        await service.revokeInstallation(await sessionReader(c), c.req.valid("param").invitationId),
        200,
      );
    } catch (error) {
      return failure(c, error, revokeKinds);
    }
  });

  app.openapi(declineInstallationInvitation, async (c) => {
    try {
      await service.declineInstallation(c.req.valid("json"));
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, declineKinds);
    }
  });

  app.openapi(registerInstallation, async (c) => {
    try {
      return c.json(await service.registerInstallation(c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error, registrationKinds);
    }
  });

  return app;
}
