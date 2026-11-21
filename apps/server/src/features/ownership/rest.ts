import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  InstallationDirectoryResponse,
  OwnershipRecovery,
  RecoverOwnershipRequest,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { OwnershipError, type OwnershipErrorKind, type OwnershipService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });

const directory = createRoute({
  method: "get",
  path: "/api/admin/workspaces",
  summary: "The installation's shared-workspace ownership directory, for system administrators",
  description:
    "Active system administrators only. Lists shared workspaces with their identity, whether an active owner remains, and each member's status. It deliberately returns no projects, issues, knowledge, or other workspace content: the administrator role grants no project access. An unauthenticated or agent-key request is 401; a non-administrator is 403.",
  responses: {
    200: {
      description: "The shared workspaces and their membership status, newest first",
      content: { "application/json": { schema: InstallationDirectoryResponse } },
    },
    401: problem("Not signed in"),
    403: problem("Not an active system administrator"),
  },
});

const recoverOwnership = createRoute({
  method: "post",
  path: "/api/admin/workspaces/{workspaceId}/recover-ownership",
  summary: "Restore ownership of an ownerless shared workspace",
  description:
    "Active system administrators only. Promotes an active member or a reactivated former owner (including the sole member whose deactivation left the workspace ownerless) in one transaction under the workspace ownership lock. Refused while an active owner remains, for self-promotion, for a still-deactivated or ineligible target, and for a missing or personal workspace. The administrator never becomes a member and gains no project access; members are notified after commit. Human browser sessions only, never agent keys.",
  request: {
    params: workspaceParams,
    body: { required: true, content: { "application/json": { schema: RecoverOwnershipRequest } } },
  },
  responses: {
    200: {
      description: "The workspace has a new owner",
      content: { "application/json": { schema: OwnershipRecovery } },
    },
    400: problem("The workspace id or request body is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an active system administrator, or self-promotion was attempted"),
    404: problem("No such shared workspace or account"),
    409: problem(
      "The workspace has an active owner, or the recipient is deactivated or ineligible",
    ),
  },
});

export const routes = [directory, recoverOwnership];

const statusFor = {
  not_signed_in: 401,
  not_system_administrator: 403,
  workspace_not_found: 404,
  human_not_found: 404,
  member_not_found: 404,
  self_recovery_forbidden: 403,
  workspace_has_active_owner: 409,
  target_deactivated: 409,
  recipient_ineligible: 409,
} as const satisfies Record<OwnershipErrorKind, number>;

function isKind<K extends readonly OwnershipErrorKind[]>(
  error: OwnershipError,
  kinds: K,
): error is OwnershipError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const directoryKinds = ["not_signed_in", "not_system_administrator"] as const;
const recoveryKinds = [
  "not_signed_in",
  "not_system_administrator",
  "workspace_not_found",
  "human_not_found",
  "member_not_found",
  "self_recovery_forbidden",
  "workspace_has_active_owner",
  "target_deactivated",
  "recipient_ineligible",
] as const;

function failure<K extends readonly OwnershipErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof OwnershipError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export function createOwnershipRest(service: OwnershipService, sessionReader: SessionReader) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(directory, async (c) => {
    try {
      return c.json(await service.directory(await sessionReader(c)), 200);
    } catch (error) {
      return failure(c, error, directoryKinds);
    }
  });

  app.openapi(recoverOwnership, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { humanId } = c.req.valid("json");
      return c.json(
        await service.recoverOwnership(await sessionReader(c), workspaceId, humanId),
        200,
      );
    } catch (error) {
      return failure(c, error, recoveryKinds);
    }
  });

  return app;
}
