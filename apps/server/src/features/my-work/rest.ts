import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { MyWorkResponse } from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { MyWorkError, type MyWorkErrorKind, type MyWorkService } from "./service.ts";

const myWork = createRoute({
  method: "get",
  path: "/api/my-work",
  summary: "My work across workspaces",
  description:
    "The signed-in human's open assigned issues, live sessions under their own agents, and open or paused needs-input questions. Every section is scoped by the caller's current effective workspace membership and project access: revoked grants and suspended or removed memberships exclude data immediately. Agent keys are not accepted; sign in as a human.",
  responses: {
    200: {
      description: "The three sections of the human's cross-workspace work",
      content: { "application/json": { schema: MyWorkResponse } },
    },
    401: problem("Not signed in as a human, or the account is deactivated"),
  },
});

export const routes = [myWork];

const statusFor = {
  not_signed_in: 401,
  human_deactivated: 401,
} as const satisfies Record<MyWorkErrorKind, number>;

export function createMyWorkRest(service: MyWorkService, sessionReader: SessionReader) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(myWork, async (c: Context) => {
    try {
      return c.json(await service.get(await sessionReader(c)), 200);
    } catch (error) {
      if (error instanceof MyWorkError) {
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
