import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { RunHookEvent, RunReportResponse, RunsResponse } from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import { RunsError, type RunsErrorKind, type RunsService } from "./service.ts";

// The REST hook endpoint from docs/design/harness-compatibility-proof.md. The bearer
// header carries the agent key; it is never in the body. The adapter authenticates and
// validates; identity, correlation, and scope are decided in service.ts.

const report = createRoute({
  method: "post",
  path: "/api/runs/hook",
  summary: "Report a harness run event with an agent key",
  description:
    "A harness hook POSTs `schema: orrery.run.hook.v1` with `Authorization: Bearer <agent-api-key>`. The key decides the agent and workspace; the run is keyed by the harness and native session id, so concurrent clients stay distinct and a resume reuses the run. Missing model or version fields stay unknown. This endpoint does not claim work or renew a lease.",
  request: {
    body: { required: true, content: { "application/json": { schema: RunHookEvent } } },
  },
  responses: {
    200: {
      description: "The report was accepted and the correlated run",
      content: { "application/json": { schema: RunReportResponse } },
    },
    400: problem("The hook event is invalid"),
    401: problem("The key is invalid, revoked, expired, or its workspace is no longer accessible"),
    404: problem("No such run belongs to this agent in this workspace"),
  },
});

const workspaceRuns = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/runs",
  summary: "List the runs and child workers in one workspace",
  description:
    "A human with access to the workspace sees each run's reported harness, model (or `unknown`), model-change history, and child workers. Runs are attributed to agents, never to a transport session.",
  request: { params: z.object({ workspaceId: z.string().min(1).max(200) }) },
  responses: {
    200: {
      description: "The workspace's runs",
      content: { "application/json": { schema: RunsResponse } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    404: problem("This workspace does not exist or you cannot access it"),
  },
});

export const routes = [report, workspaceRuns];

const statusFor = {
  not_signed_in: 401,
  run_not_found: 404,
  workspace_not_found: 404,
} as const satisfies Record<RunsErrorKind, number>;

function isKind<K extends readonly RunsErrorKind[]>(
  error: RunsError,
  kinds: K,
): error is RunsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

// Thin: resolve the bearer key here (never falling back to a session cookie), call the
// service with the identity, and map failures to RFC 9457 Problems. An agent key that
// fails authentication keeps its own stable code and status, exactly as in projects.
function failure<K extends readonly RunsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (isAgentError(error)) {
    return problemResponse(c, {
      status: 401,
      code: error.kind,
      title: error.message,
    });
  }
  if (error instanceof RunsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

const reportKinds = ["not_signed_in", "run_not_found"] as const;
const listKinds = ["not_signed_in", "workspace_not_found"] as const;

export function createRunsRest(
  service: RunsService,
  sessionReader: SessionReader,
  authenticate: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(report, async (c) => {
    try {
      const identity = await authenticate(c.req.raw);
      return c.json(await service.report(identity, c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error, reportKinds);
    }
  });

  app.openapi(workspaceRuns, async (c) => {
    try {
      return c.json(
        {
          runs: await service.listWorkspaceRuns(
            await sessionReader(c),
            c.req.valid("param").workspaceId,
          ),
        },
        200,
      );
    } catch (error) {
      return failure(c, error, listKinds);
    }
  });

  return app;
}
