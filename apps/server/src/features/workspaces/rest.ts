import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { WorkspacesResponse } from "@orrery/contract";
import type { Context } from "hono";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { WorkspacesError, type WorkspacesService } from "./service.ts";

const listWorkspaces = createRoute({
  method: "get",
  path: "/api/workspaces",
  summary: "The workspaces the signed-in account can access",
  description:
    "The caller's personal workspace; shared memberships arrive with #24. Another person's personal workspace never appears here, not even for a system administrator.",
  responses: {
    200: {
      description: "The caller's workspaces",
      content: { "application/json": { schema: WorkspacesResponse } },
    },
    401: problem("Not signed in"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [listWorkspaces];

// Every route's error answer in one place: a Problem at the kind's status. A kind the
// route does not answer is a programming error: it stays a 500.
function failure(c: Context, error: unknown) {
  if (error instanceof WorkspacesError && error.kind === "not_signed_in") {
    return problemResponse(c, { status: 401, code: error.kind, title: error.message });
  }
  throw error;
}

// Thin: resolve the session, call the service, map the result to HTTP. The service
// decides who may do what; this layer only carries it, and every error is a Problem
// built through platform/problem.ts (ADR-0003).
export function createWorkspacesRest(service: WorkspacesService, sessionReader: SessionReader) {
  // Validation failures answer as a validation_failed Problem, like every other error.
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(listWorkspaces, async (c) => {
    try {
      return c.json(await service.list(await sessionReader(c)), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}
