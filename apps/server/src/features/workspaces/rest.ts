import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AcceptWorkspaceInvitationRequest,
  AppointWorkspaceOwnerRequest,
  CreateWorkspaceRequest,
  InviteWorkspaceMemberRequest,
  RegisterThroughWorkspaceInvitationRequest,
  SessionResponse,
  Workspace,
  WorkspaceInvitation,
  WorkspaceInvitationPreview,
  WorkspaceInvitationToken,
  WorkspaceMember,
  WorkspaceMembersResponse,
  WorkspacesResponse,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { deliveryProblem } from "../settings/index.ts";
import { WorkspacesError, type WorkspacesErrorKind, type WorkspacesService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const memberParams = workspaceParams.extend({ humanId: z.string().min(1).max(200) });
const previewQuery = z.object({ token: WorkspaceInvitationToken });

const listWorkspaces = createRoute({
  method: "get",
  path: "/api/workspaces",
  summary: "The workspaces the signed-in account can access",
  description:
    "The caller's personal workspace plus every shared workspace they belong to, with whether they own each one. Another person's workspace never appears here, not even for a system administrator.",
  responses: {
    200: {
      description: "The caller's workspaces",
      content: { "application/json": { schema: WorkspacesResponse } },
    },
    401: problem("Not signed in"),
  },
});

const getWorkspace = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}",
  summary: "One workspace the signed-in account can access",
  description:
    "The caller's personal workspace or a shared workspace they belong to. A workspace outside the caller's access answers exactly like a missing one.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace",
      content: { "application/json": { schema: Workspace } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    404: problem("No workspace with this id is accessible to the caller"),
  },
});

const listWorkspaceMembers = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/members",
  summary: "The members of a shared workspace",
  description:
    "Owners only: the directory used to appoint another owner or remove a member. Ordinary members do not receive everyone else's address.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace's members",
      content: { "application/json": { schema: WorkspaceMembersResponse } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner of this workspace"),
    404: problem("No accessible shared workspace"),
  },
});

const createWorkspace = createRoute({
  method: "post",
  path: "/api/workspaces",
  summary: "Create a shared workspace",
  description:
    "Creates a shared workspace and makes the signed-in human its first owner in one transaction.",
  request: {
    body: { required: true, content: { "application/json": { schema: CreateWorkspaceRequest } } },
  },
  responses: {
    201: {
      description: "The shared workspace, owned by the creator",
      content: { "application/json": { schema: Workspace } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
  },
});

const inviteWorkspaceMember = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/invitations",
  summary: "Invite an email into a shared workspace",
  description:
    "Owners only, and the inviter's email must be verified. A single-use link valid for seven days goes to the invited address. An existing account accepts it after signing in; a new address registers through it. Following the link (GET) changes nothing.",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: { "application/json": { schema: InviteWorkspaceMemberRequest } },
    },
  },
  responses: {
    201: {
      description: "The invitation, pending",
      content: { "application/json": { schema: WorkspaceInvitation } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner, or the inviter's email is unverified"),
    404: problem("No shared workspace with this id is accessible to the caller"),
    409: problem(
      "The invitee is already a member or already has a pending invitation, or SMTP is not configured or its stored password is unreadable",
    ),
    502: problem("The SMTP server refused the message; the code says why"),
  },
});

const previewWorkspaceInvitation = createRoute({
  method: "get",
  path: "/api/workspace-invitations/preview",
  summary: "The workspace and address a workspace invitation link offers",
  description:
    "A read-only preview of a single-use invitation token. It never consumes the token and changes nothing. Invalid, expired, used, or failed-delivery links answer the same Problem.",
  request: { query: previewQuery },
  responses: {
    200: {
      description: "The invitation's workspace and invited address",
      content: { "application/json": { schema: WorkspaceInvitationPreview } },
    },
    400: problem("The token is invalid, expired, or already used"),
  },
});

const acceptWorkspaceInvitation = createRoute({
  method: "post",
  path: "/api/workspace-invitations/acceptance",
  summary: "Accept a workspace invitation as an existing account",
  description:
    "Redeems the emailed token for the signed-in account. The account's verified email must equal the invited address; a forwarded link cannot attach the membership to another account. The token is consumed only by this POST.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AcceptWorkspaceInvitationRequest } },
    },
  },
  responses: {
    200: {
      description: "The workspace, now a membership of the signed-in account",
      content: { "application/json": { schema: Workspace } },
    },
    400: problem("The token is invalid, expired, or already used"),
    401: problem("Not signed in"),
    403: problem(
      "The signed-in account has a different or unverified email, or the inviter no longer has authority",
    ),
    409: problem("The account is already a member of the workspace"),
  },
});

const registerThroughWorkspaceInvitation = createRoute({
  method: "post",
  path: "/api/workspace-invitations/registration",
  summary: "Register a new account through a workspace invitation",
  description:
    "Redeems the token for an address with no account, creating the account, its personal workspace, the verified-email mark, and the workspace membership in one transaction. An existing account answers account_exists and signs in to accept instead.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: RegisterThroughWorkspaceInvitationRequest },
      },
    },
  },
  responses: {
    200: {
      description: "The account, with its email verified and the membership created",
      content: { "application/json": { schema: SessionResponse } },
    },
    400: problem("The token is invalid, expired, or already used"),
    403: problem("The inviter no longer has authority to invite to this workspace"),
    409: problem("The invited email already has an account"),
  },
});

const appointWorkspaceOwner = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/owners",
  summary: "Appoint a member as another owner",
  description:
    "Owners only. The target must already be a member; an existing owner is returned unchanged.",
  request: {
    params: workspaceParams,
    body: {
      required: true,
      content: { "application/json": { schema: AppointWorkspaceOwnerRequest } },
    },
  },
  responses: {
    200: {
      description: "The member, now an owner",
      content: { "application/json": { schema: WorkspaceMember } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner of this workspace"),
    404: problem("No accessible shared workspace or member"),
  },
});

const removeWorkspaceMember = createRoute({
  method: "delete",
  path: "/api/workspaces/{workspaceId}/members/{humanId}",
  summary: "Remove a member from a shared workspace",
  description:
    "Owners only. Removing an owner is refused when it would leave the workspace with no owner. The removed human keeps their personal workspace and every other membership.",
  request: { params: memberParams },
  responses: {
    204: { description: "The membership was removed" },
    400: problem("The workspace or member id is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner of this workspace"),
    404: problem("No accessible shared workspace or member"),
    409: problem("Removing this owner would leave the workspace with no owner"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [
  listWorkspaces,
  getWorkspace,
  listWorkspaceMembers,
  createWorkspace,
  inviteWorkspaceMember,
  previewWorkspaceInvitation,
  acceptWorkspaceInvitation,
  registerThroughWorkspaceInvitation,
  appointWorkspaceOwner,
  removeWorkspaceMember,
];

// Transport details rest.ts owns: every workspaces error kind's HTTP status.
const statusFor = {
  not_signed_in: 401,
  workspace_not_found: 404,
  not_workspace_owner: 403,
  inviter_unverified: 403,
  inviter_not_authorized: 403,
  invitation_invalid: 400,
  invitation_recipient_mismatch: 403,
  email_unverified: 403,
  invitation_pending: 409,
  already_member: 409,
  account_exists: 409,
  member_not_found: 404,
  last_owner: 409,
} as const satisfies Record<WorkspacesErrorKind, number>;

// True when the error's kind is one of the route's kinds. A type guard is the honest
// way to narrow; no assertions.
function isKind<K extends readonly WorkspacesErrorKind[]>(
  error: WorkspacesError,
  kinds: K,
): error is WorkspacesError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

// The kinds each route's service calls can throw. A route answers exactly these; a kind
// it does not answer is a programming error and stays a 500.
const listKinds = ["not_signed_in"] as const;
const getKinds = ["not_signed_in", "workspace_not_found"] as const;
const membersKinds = ["not_signed_in", "workspace_not_found", "not_workspace_owner"] as const;
const createKinds = ["not_signed_in"] as const;
const inviteKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "inviter_unverified",
  "already_member",
  "invitation_pending",
] as const;
const previewKinds = ["invitation_invalid"] as const;
const acceptKinds = [
  "not_signed_in",
  "invitation_invalid",
  "inviter_not_authorized",
  "invitation_recipient_mismatch",
  "email_unverified",
  "already_member",
] as const;
const registerKinds = ["invitation_invalid", "inviter_not_authorized", "account_exists"] as const;
const appointKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "member_not_found",
] as const;
const removeKinds = [
  "not_signed_in",
  "workspace_not_found",
  "not_workspace_owner",
  "member_not_found",
  "last_owner",
] as const;

// Thin: resolve the session, call the service, map the result to HTTP. The service
// decides who may do what; this layer only carries it, and every error is a Problem
// built through platform/problem.ts (ADR-0003).
function failure<K extends readonly WorkspacesErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof WorkspacesError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

// The invitation send also answers every delivery failure with settings' own code and
// status, so a client can tell the reasons apart wherever the send happened.
function sendFailure(c: Context, error: unknown) {
  if (error instanceof WorkspacesError && isKind(error, inviteKinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  const delivery = deliveryProblem(c, error);
  if (delivery !== undefined) return delivery;
  throw error;
}

export function createWorkspacesRest(service: WorkspacesService, sessionReader: SessionReader) {
  // Validation failures answer as a validation_failed Problem, like every other error.
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(listWorkspaces, async (c) => {
    try {
      return c.json(await service.list(await sessionReader(c)), 200);
    } catch (error) {
      return failure(c, error, listKinds);
    }
  });

  app.openapi(getWorkspace, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.get(await sessionReader(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, getKinds);
    }
  });

  app.openapi(listWorkspaceMembers, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.members(await sessionReader(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, membersKinds);
    }
  });

  app.openapi(createWorkspace, async (c) => {
    try {
      return c.json(await service.create(await sessionReader(c), c.req.valid("json")), 201);
    } catch (error) {
      return failure(c, error, createKinds);
    }
  });

  app.openapi(inviteWorkspaceMember, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(
        await service.invite(await sessionReader(c), workspaceId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return sendFailure(c, error);
    }
  });

  app.openapi(previewWorkspaceInvitation, async (c) => {
    try {
      return c.json(await service.previewInvitation(c.req.valid("query").token), 200);
    } catch (error) {
      return failure(c, error, previewKinds);
    }
  });

  app.openapi(acceptWorkspaceInvitation, async (c) => {
    try {
      return c.json(
        await service.acceptInvitation(await sessionReader(c), c.req.valid("json").token),
        200,
      );
    } catch (error) {
      return failure(c, error, acceptKinds);
    }
  });

  app.openapi(registerThroughWorkspaceInvitation, async (c) => {
    try {
      return c.json(await service.registerThroughInvitation(c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error, registerKinds);
    }
  });

  app.openapi(appointWorkspaceOwner, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(
        await service.appointOwner(
          await sessionReader(c),
          workspaceId,
          c.req.valid("json").humanId,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, appointKinds);
    }
  });

  app.openapi(removeWorkspaceMember, async (c) => {
    try {
      const { workspaceId, humanId } = c.req.valid("param");
      await service.removeMember(await sessionReader(c), workspaceId, humanId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, removeKinds);
    }
  });

  return app;
}
