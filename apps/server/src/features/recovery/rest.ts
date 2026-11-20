import { ConfirmPasswordReset, RecoveryMessage, RequestPasswordReset } from "@orrery/contract";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import { RecoveryError, type RecoveryService } from "./service.ts";

const requestPasswordReset = createRoute({
  method: "post",
  path: "/api/auth/password-reset/request",
  summary: "Ask for a password reset link",
  description:
    "Always answers the same way, whether or not the address has an account and whether or not its email is verified (#20). Only a verified address is sent mail, and a broken relay is swallowed with the same answer rather than disclosed. No link is sent for an unverified address: that account recovers locally. The emailed link changes nothing on GET; a POST to the confirm route is what sets a password.",
  request: {
    body: { required: true, content: { "application/json": { schema: RequestPasswordReset } } },
  },
  responses: {
    200: {
      description: "The same answer for every address",
      content: { "application/json": { schema: RecoveryMessage } },
    },
    400: problem("The request is invalid"),
  },
});

const confirmPasswordReset = createRoute({
  method: "post",
  path: "/api/auth/password-reset/confirm",
  summary: "Set a new password with the token from the reset email",
  description:
    "Redeems the emailed token and sets the new password in one transaction. The token is single-use, short-lived, and checked in database time; the link's GET changes nothing. Every prior browser session for the account is signed out, while agent API keys stay live. No account or email state is disclosed beyond the token's bearer.",
  request: {
    body: { required: true, content: { "application/json": { schema: ConfirmPasswordReset } } },
  },
  responses: {
    200: {
      description: "The password was reset",
      content: { "application/json": { schema: RecoveryMessage } },
    },
    400: problem("The request is invalid, or the link is invalid, expired, or already used"),
    403: problem("The account is deactivated"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [requestPasswordReset, confirmPasswordReset];

// Thin: call the service, map its one transport error to a Problem (ADR-0003). Anything
// else is a bug and stays a 500; no policy lives here.
export function createRecoveryRest(service: RecoveryService) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(requestPasswordReset, async (c) =>
    c.json(await service.requestReset(c.req.valid("json").email), 200),
  );

  app.openapi(confirmPasswordReset, async (c) => {
    try {
      const { token, password } = c.req.valid("json");
      return c.json(await service.confirmReset(token, password), 200);
    } catch (error) {
      if (
        error instanceof RecoveryError &&
        (error.kind === "reset_token_invalid" || error.kind === "account_deactivated")
      ) {
        return failure(c, error);
      }
      throw error;
    }
  });

  return app;
}

const failure = (c: Context, error: RecoveryError) =>
  problemResponse(c, {
    status: error.kind === "account_deactivated" ? 403 : 400,
    code: error.kind,
    title: error.message,
  });
