import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HistoryResponse } from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { HistoryError, type HistoryErrorKind, type HistoryService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const projectParams = z.object({ projectId: z.string().min(1).max(200) });

const workspaceHistory = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/history",
  summary: "The access history of a workspace the caller manages",
  description:
    "Workspace owners see membership, permission, credential, and project access events in this workspace; a delegated permission manager sees membership and permission events plus access changes on projects they Manage. An ordinary member or a non-member gets no history: a non-member answers exactly like a missing workspace. No credential secret is ever returned.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace's access events, newest first",
      content: { "application/json": { schema: HistoryResponse } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    403: problem("Not an owner or delegated permission manager of this workspace"),
    404: problem("No workspace with this id is accessible to the caller"),
  },
});

const projectHistory = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/history",
  summary: "The activity and access history of a granted project",
  description:
    "Any human with granted access to the project sees its attributed activity. Only a project manager, including a workspace owner, additionally sees who granted, changed, or revoked project access. A project outside the caller's access answers exactly like a missing one, so history cannot enumerate projects.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's visible events, newest first",
      content: { "application/json": { schema: HistoryResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const installationHistory = createRoute({
  method: "get",
  path: "/api/installation/history",
  summary: "The installation's access history, for system administrators",
  description:
    "System administrators only: the bootstrap record and the lifecycle of installation invitations. The administrator role alone grants no workspace or project access, so no private project content or workspace the administrator does not belong to appears here.",
  responses: {
    200: {
      description: "The installation's access events, newest first",
      content: { "application/json": { schema: HistoryResponse } },
    },
    401: problem("Not signed in"),
    403: problem("Not a system administrator"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [workspaceHistory, projectHistory, installationHistory];

const statusFor = {
  not_signed_in: 401,
  workspace_not_found: 404,
  project_not_found: 404,
  not_workspace_owner: 403,
  not_system_administrator: 403,
} as const satisfies Record<HistoryErrorKind, number>;

function isKind<K extends readonly HistoryErrorKind[]>(
  error: HistoryError,
  kinds: K,
): error is HistoryError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const workspaceKinds = ["not_signed_in", "workspace_not_found", "not_workspace_owner"] as const;
const projectKinds = ["not_signed_in", "project_not_found"] as const;
const installationKinds = ["not_signed_in", "not_system_administrator"] as const;

function failure<K extends readonly HistoryErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof HistoryError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export function createHistoryRest(service: HistoryService, sessionReader: SessionReader) {
  // Validation failures answer as a validation_failed Problem, like every other error.
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(workspaceHistory, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.workspaceHistory(await sessionReader(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, workspaceKinds);
    }
  });

  app.openapi(projectHistory, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.projectHistory(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectKinds);
    }
  });

  app.openapi(installationHistory, async (c) => {
    try {
      return c.json(await service.installationHistory(await sessionReader(c)), 200);
    } catch (error) {
      return failure(c, error, installationKinds);
    }
  });

  return app;
}
