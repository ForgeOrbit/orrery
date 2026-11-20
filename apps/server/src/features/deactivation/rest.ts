import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AccountStatus } from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import {
  DeactivationError,
  type DeactivationErrorKind,
  type DeactivationService,
} from "./service.ts";

const accountParams = z.object({ humanId: z.string().min(1).max(200) });

const deactivate = createRoute({
  method: "post",
  path: "/api/admin/accounts/{humanId}/deactivate",
  summary: "Deactivate a human account across the installation",
  description:
    "System administrators only. In one transaction: stop browser sessions, revoke the account's agents' keys in every workspace, release their active claims, revoke their shared project grants, suspend their shared memberships while keeping ownership history, and record a secret-free event. The last active administrator cannot be deactivated. Authorship and personal work are preserved.",
  request: { params: accountParams },
  responses: {
    200: {
      description: "The account is deactivated",
      content: { "application/json": { schema: AccountStatus } },
    },
    400: problem("The account id is invalid"),
    401: problem("Not signed in"),
    403: problem("Not a system administrator"),
    404: problem("No account has that id"),
    409: problem("Already deactivated, or the last active administrator"),
  },
});

const reactivate = createRoute({
  method: "post",
  path: "/api/admin/accounts/{humanId}/reactivate",
  summary: "Reactivate a deactivated human account",
  description:
    "System administrators only. Clears the account's deactivated mark and records a secret-free event. Personal work is immediately available again; shared memberships stay suspended, old project grants and agent keys stay revoked, and ownership is never restored automatically. A fresh invitation and new keys are required for shared access.",
  request: { params: accountParams },
  responses: {
    200: {
      description: "The account is active again",
      content: { "application/json": { schema: AccountStatus } },
    },
    400: problem("The account id is invalid"),
    401: problem("Not signed in"),
    403: problem("Not a system administrator"),
    404: problem("No account has that id"),
    409: problem("The account is not deactivated"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [deactivate, reactivate];

const statusFor = {
  not_signed_in: 401,
  not_system_administrator: 403,
  account_not_found: 404,
  last_admin: 409,
  already_deactivated: 409,
  already_active: 409,
} as const satisfies Record<DeactivationErrorKind, number>;

function isKind<K extends readonly DeactivationErrorKind[]>(
  error: DeactivationError,
  kinds: K,
): error is DeactivationError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const deactivateKinds = [
  "not_signed_in",
  "not_system_administrator",
  "account_not_found",
  "last_admin",
  "already_deactivated",
] as const;
const reactivateKinds = [
  "not_signed_in",
  "not_system_administrator",
  "account_not_found",
  "already_active",
] as const;

function failure<K extends readonly DeactivationErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof DeactivationError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

// Thin: validate, resolve the session, call the service, map the result. No policy here.
export function createDeactivationRest(service: DeactivationService, sessionReader: SessionReader) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(deactivate, async (c) => {
    try {
      const { humanId } = c.req.valid("param");
      return c.json(await service.deactivate(await sessionReader(c), humanId), 200);
    } catch (error) {
      return failure(c, error, deactivateKinds);
    }
  });

  app.openapi(reactivate, async (c) => {
    try {
      const { humanId } = c.req.valid("param");
      return c.json(await service.reactivate(await sessionReader(c), humanId), 200);
    } catch (error) {
      return failure(c, error, reactivateKinds);
    }
  });

  return app;
}
