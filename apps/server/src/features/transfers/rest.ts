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

const previewTransfer = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/transfer/preview",
  summary: "Preview a project transfer",
  description:
    "The source owner sees where the project would go, the visibility and access changes, and any live work that must finish first. Both personal-to-shared (#39) and shared-to-shared (#46) moves are supported. Nothing is written.",
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
    404: problem("No project owned by the caller or shared workspace with these ids is accessible"),
  },
});

const authorizeTransfer = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/transfer",
  summary: "Authorize a project transfer",
  description:
    "The source owner (a personal workspace's owner, or a shared workspace's owner) authorizes moving the project into a different shared workspace and receives a one-time token. A destination owner or a member with Create projects then accepts. The authorization is recorded in the source workspace's history.",
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
    404: problem("No project owned by the caller or shared workspace with these ids is accessible"),
  },
});

const receiverPreviewTransfer = createRoute({
  method: "post",
  path: "/api/transfers/preview",
  summary: "Preview an authorized transfer before accepting it",
  description:
    "A destination owner or a member with Create projects redeems the one-time token to see the destination, visibility and access changes, and any live work before confirming acceptance. A stranger, a non-member or a used token answers exactly like a missing authorization.",
  request: {
    body: { required: true, content: { "application/json": { schema: AcceptTransferRequest } } },
  },
  responses: {
    200: {
      description: "The access changes and active work the receiver would accept",
      content: { "application/json": { schema: TransferPreview } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("The receiver lacks Create projects in the destination"),
    404: problem("No pending transfer authorization is accessible to the caller"),
  },
});

const completeTransfer = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/transfer/complete",
  summary: "Transfer a project directly",
  description:
    "One person who owns the source project (personally or in a shared workspace) and also holds Create projects in the destination completes both authorization and acceptance in a single transaction.",
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
    404: problem("No project owned by the caller or shared workspace with these ids is accessible"),
    409: problem(
      "Active work remains, the project changed, or its key collides in the destination",
    ),
  },
});

const acceptTransfer = createRoute({
  method: "post",
  path: "/api/transfers/accept",
  summary: "Accept an authorized project transfer",
  description:
    "A destination owner or a member with Create projects accepts a pending authorization. Every authority (including the source owner's, who may have since lost ownership), the project's current ownership and the absence of live work are rechecked in one transaction before access is rebuilt under the destination.",
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
    404: problem("No accessible project, destination, or pending authorization"),
    409: problem(
      "The project changed, active work remains, or its key collides in the destination",
    ),
  },
});

export const routes = [
  previewTransfer,
  authorizeTransfer,
  receiverPreviewTransfer,
  completeTransfer,
  acceptTransfer,
];

const statusFor = {
  not_signed_in: 401,
  project_not_found: 404,
  workspace_not_found: 404,
  destination_authority_required: 403,
  same_workspace: 400,

  transfer_invalid: 404,
  transfer_stale: 409,
  source_authority_lost: 409,
  active_work: 409,
  project_key_conflict: 409,
  project_key_immutable: 409,
} as const satisfies Record<TransfersErrorKind, number>;

function isKind<K extends readonly TransfersErrorKind[]>(
  error: TransfersError,
  kinds: K,
): error is TransfersError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const ownerKinds = [
  "not_signed_in",
  "project_not_found",
  "workspace_not_found",
  "same_workspace",
] as const;
const receiverKinds = [
  "not_signed_in",
  "destination_authority_required",
  "transfer_invalid",
] as const;
const acceptKinds = [
  ...ownerKinds,
  "destination_authority_required",
  "transfer_invalid",
  "transfer_stale",
  "source_authority_lost",
  "active_work",
  "project_key_conflict",
  "project_key_immutable",
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

  app.openapi(receiverPreviewTransfer, async (c) => {
    try {
      return c.json(
        await service.receiverPreview(await sessionReader(c), c.req.valid("json").token),
        200,
      );
    } catch (error) {
      return failure(c, error, receiverKinds);
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
          c.req.valid("json").key,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, acceptKinds);
    }
  });

  app.openapi(acceptTransfer, async (c) => {
    try {
      return c.json(
        await service.accept(
          await sessionReader(c),
          c.req.valid("json").token,
          c.req.valid("json").key,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, acceptKinds);
    }
  });

  return app;
}
