import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AcceptTransferRequest,
  AuthorizeTransferRequest,
  CompleteTransferRequest,
  Project,
  TransferAuthorization,
  TransferPreview,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { TransfersError, type TransfersErrorKind, type TransfersService } from "./service.ts";

const projectParams = z.object({ projectId: z.string().min(1).max(200) });

// A transfer is an ownership decision, not project work. Only a human session is
// accepted; there is deliberately no bearer-key path and no MCP tool for it.

const previewTransfer = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/transfer/preview",
  summary: "Preview a personal-to-shared transfer",
  description:
    "The personal owner sees where the project would go, the visibility and access changes, and any live work that must finish first. Nothing is written.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "application/json": { schema: AuthorizeTransferRequest } },
    },
  },
  responses: {
    200: {
      description: "The access changes and active work a transfer would produce",
      content: { "application/json": { schema: TransferPreview } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No personal project or shared workspace with these ids is accessible"),
  },
});

const authorizeTransfer = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/transfer",
  summary: "Authorize a personal-to-shared transfer",
  description:
    "The personal workspace owner authorizes moving the project into a shared workspace and receives a one-time token. A destination owner or a member with Create projects then accepts. The authorization is recorded in the source workspace's history.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "application/json": { schema: AuthorizeTransferRequest } },
    },
  },
  responses: {
    201: {
      description: "The authorization and its one-time token",
      content: { "application/json": { schema: TransferAuthorization } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No personal project or shared workspace with these ids is accessible"),
  },
});

const completeTransfer = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/transfer/complete",
  summary: "Transfer a personal project directly",
  description:
    "One person who owns the personal project and also holds Create projects in the shared destination completes both authorization and acceptance in a single transaction.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "application/json": { schema: CompleteTransferRequest } },
    },
  },
  responses: {
    200: {
      description: "The project in its destination workspace",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller lacks Create projects in the destination"),
    404: problem("No personal project or shared workspace with these ids is accessible"),
    409: problem("Active work remains, or the project changed since authorization"),
  },
});

const acceptTransfer = createRoute({
  method: "post",
  path: "/api/transfers/accept",
  summary: "Accept an authorized personal-to-shared transfer",
  description:
    "A destination owner or a member with Create projects accepts a pending authorization. Every authority, the project's current ownership and the absence of live work are rechecked in one transaction before access is rebuilt under the destination.",
  request: {
    body: { required: true, content: { "application/json": { schema: AcceptTransferRequest } } },
  },
  responses: {
    200: {
      description: "The project in its destination workspace",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller lacks Create projects in the destination"),
    404: problem("No personal project or shared workspace with these ids is accessible"),
    409: problem("The authorization is invalid, stale, or active work remains"),
  },
});

export const routes = [previewTransfer, authorizeTransfer, completeTransfer, acceptTransfer];

const statusFor = {
  not_signed_in: 401,
  project_not_found: 404,
  workspace_not_found: 404,
  not_personal_project_owner: 403,
  destination_authority_required: 403,
  transfer_invalid: 409,
  transfer_stale: 409,
  source_authority_lost: 409,
  active_work: 409,
} as const satisfies Record<TransfersErrorKind, number>;

function isKind<K extends readonly TransfersErrorKind[]>(
  error: TransfersError,
  kinds: K,
): error is TransfersError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const ownerKinds = ["not_signed_in", "project_not_found", "workspace_not_found"] as const;
const acceptKinds = [
  ...ownerKinds,
  "destination_authority_required",
  "transfer_invalid",
  "transfer_stale",
  "source_authority_lost",
  "active_work",
] as const;

function failure<K extends readonly TransfersErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof TransfersError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export function createTransfersRest(service: TransfersService, sessionReader: SessionReader) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(previewTransfer, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.preview(
          await sessionReader(c),
          projectId,
          c.req.valid("json").destinationWorkspaceId,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, ownerKinds);
    }
  });

  app.openapi(authorizeTransfer, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.authorize(
          await sessionReader(c),
          projectId,
          c.req.valid("json").destinationWorkspaceId,
        ),
        201,
      );
    } catch (error) {
      return failure(c, error, ownerKinds);
    }
  });

  app.openapi(completeTransfer, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.complete(
          await sessionReader(c),
          projectId,
          c.req.valid("json").destinationWorkspaceId,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, acceptKinds);
    }
  });

  app.openapi(acceptTransfer, async (c) => {
    try {
      return c.json(await service.accept(await sessionReader(c), c.req.valid("json").token), 200);
    } catch (error) {
      return failure(c, error, acceptKinds);
    }
  });

  return app;
}
