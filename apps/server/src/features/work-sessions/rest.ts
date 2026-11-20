import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ClaimWorkSessionInput,
  IssuesResponse,
  ReacquireWorkSessionInput,
  RenewWorkSessionInput,
  ReportProgressInput,
  RequestStopWorkSessionInput,
  ResumeWorkSessionInput,
  ResumeWorkSessionResult,
  StopWorkSessionInput,
  WorkSession,
  WorkSessionsResponse,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import type { WorkActor } from "../projects/index.ts";
import { SessionsError, type SessionsErrorKind, type SessionsService } from "./service.ts";

// Thin REST adapter for work sessions (#36). Every decision is in service.ts: the bearer
// key resolves to an agent identity, the session's identity comes from the service, and
// every error is an RFC 9457 Problem built through platform/problem.ts.

const issueParams = z.object({ issueId: z.string().min(1).max(200) });
const projectParams = z.object({ projectId: z.string().min(1).max(200) });
const claimBody = ClaimWorkSessionInput.omit({ issueId: true });
const renewBody = RenewWorkSessionInput.omit({ issueId: true });
const progressBody = ReportProgressInput.omit({ issueId: true });
const stopBody = StopWorkSessionInput.omit({ issueId: true });
const stopRequestBody = RequestStopWorkSessionInput.omit({ issueId: true });
const resumeBody = ResumeWorkSessionInput.omit({ issueId: true });
const reacquireBody = ReacquireWorkSessionInput.omit({ issueId: true });

const claim = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/work-sessions",
  summary: "Claim an issue for an agent and run",
  description:
    "Start a work session. The session belongs to the authenticated agent, the named run, the key's workspace and the issue — not to the key itself. At most one active session can hold an issue; helpers passing the same (agent, run, issue) join it. The claim is a five-minute lease evaluated in database time.",
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: claimBody } } },
  },
  responses: {
    201: {
      description: "The active work session",
      content: { "application/json": { schema: WorkSession } },
    },
    400: problem("The claim is invalid"),
    401: problem("An agent key is required, or the key is invalid or revoked"),
    403: problem("Contribute access is required to claim this issue"),
    404: problem("No such issue or run is in scope for this agent"),
    409: problem("Another worker holds the active session for this issue"),
  },
});

const renew = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/work-sessions/renew",
  summary: "Check in and renew a claim",
  description:
    "Refresh the five-minute lease in database time for the live session this agent holds on the issue. An expired or released session is never renewed or silently reacquired. An optional sessionId fences a delayed call from an interrupted session.",
  request: {
    params: issueParams,
    body: { required: false, content: { "application/json": { schema: renewBody } } },
  },
  responses: {
    200: {
      description: "The renewed session",
      content: { "application/json": { schema: WorkSession } },
    },
    400: problem("The issue id is invalid"),
    401: problem("An agent key is required, or the key is invalid or revoked"),
    403: problem("Contribute access is required to renew this claim"),
    404: problem("No such issue is in scope for this agent"),
    409: problem("This agent holds no live session for this issue"),
  },
});

const progress = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/work-sessions/progress",
  summary: "Record progress on a live session",
  description:
    "Store a progress summary on the live session this agent holds. Progress is held independently of the lease, so expiry never erases it. Requires a live session; an optional sessionId fences a delayed report from an expired one.",
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: progressBody } } },
  },
  responses: {
    200: {
      description: "The session with its updated progress",
      content: { "application/json": { schema: WorkSession } },
    },
    400: problem("The progress report is invalid"),
    401: problem("An agent key is required, or the key is invalid or revoked"),
    403: problem("Contribute access is required to work on this issue"),
    404: problem("No such issue is in scope for this agent"),
    409: problem("This agent holds no live session for this issue"),
  },
});

const stop = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/work-sessions/stop",
  summary: "Complete or release a live session",
  description:
    "End the live session this agent holds. Stopping is distinct from closing the issue; the outcome records whether the work completed or was released for another worker. An optional sessionId fences a delayed completion from an expired session.",
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: stopBody } } },
  },
  responses: {
    200: {
      description: "The ended session",
      content: { "application/json": { schema: WorkSession } },
    },
    400: problem("The stop request is invalid"),
    401: problem("An agent key is required, or the key is invalid or revoked"),
    403: problem("Contribute access is required to work on this issue"),
    404: problem("No such issue is in scope for this agent"),
    409: problem("This agent holds no live session for this issue"),
  },
});

const requestStop = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/work-sessions/stop-request",
  summary: "Ask the holding agent to stop",
  description:
    "A human with Contribute or Manage on the project asks the agent holding the live session to stop. The session stays active (shown as stopping) and the agent learns of the request on its next renew or progress check-in. The five-minute lease remains the hard backstop. Agents, Readers and non-members are refused; an inactive or expired session cannot be stopped.",
  request: {
    params: issueParams,
    body: { required: false, content: { "application/json": { schema: stopRequestBody } } },
  },
  responses: {
    200: {
      description: "The session carrying the recorded stop request",
      content: { "application/json": { schema: WorkSession } },
    },
    400: problem("The stop request is invalid"),
    401: problem("Not signed in as a human"),
    403: problem("Only a human with Contribute or Manage on the project may request a stop"),
    404: problem("No such issue is in scope for the caller"),
    409: problem("The work session is no longer active"),
  },
});

const resume = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/work-sessions/resume",
  summary: "Inspect the original run's claim after an interruption",
  description:
    "Report how the named run's claim on this issue stands: active, expired, ended or none, with the progress recorded before any interruption. Evaluated in database time as a read; it never renews or resurrects an expired lease.",
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: resumeBody } } },
  },
  responses: {
    200: {
      description: "The run's claim disposition and session",
      content: { "application/json": { schema: ResumeWorkSessionResult } },
    },
    400: problem("The resume request is invalid"),
    401: problem("An agent key is required, or the key is invalid or revoked"),
    403: problem("Read access is required to inspect this issue"),
    404: problem("No such issue or run is in scope for this agent"),
  },
});

const reacquire = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/work-sessions/reacquire",
  summary: "Reacquire this run's expired claim",
  description:
    "Re-arm the named run's expired claim on this issue as a new active session for the same agent, run, workspace and issue, carrying forward the recorded progress. Allowed only while no other worker holds a live claim and the issue is not paused for input. Retries with the same run return the same session; a stale call is never turned into a fresh claim.",
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: reacquireBody } } },
  },
  responses: {
    201: {
      description: "The reacquired active session",
      content: { "application/json": { schema: WorkSession } },
    },
    400: problem("The reacquire request is invalid"),
    401: problem("An agent key is required, or the key is invalid or revoked"),
    403: problem("Contribute access is required to reacquire this claim"),
    404: problem("No such issue or run is in scope for this agent"),
    409: problem(
      "The issue is claimed by another worker or paused for input, or the claim was never expired",
    ),
  },
});

const current = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/work-sessions",
  summary: "The most recent work session for an issue",
  description:
    "Read the last session recorded for an issue, including its progress and the lease deadline. A stale active lease is reported as expired in database time. This read needs no claim and never renews one.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The most recent session",
      content: { "application/json": { schema: WorkSession } },
    },
    400: problem("The issue id is invalid"),
    401: problem("Not signed in, or the agent key is invalid or revoked"),
    403: problem("Read access is required to inspect this issue"),
    404: problem("No such issue or session is in scope for the caller"),
    409: problem("No session was recorded for this issue"),
  },
});

const all = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/work-sessions/all",
  summary: "Every work session recorded for an issue",
  description:
    "Read the full history of sessions for an issue, newest first: active, completed, released and expired. This read needs no claim.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue's sessions",
      content: { "application/json": { schema: WorkSessionsResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem("Not signed in, or the agent key is invalid or revoked"),
    403: problem("Read access is required to inspect this issue"),
    404: problem("No such issue is in scope for the caller"),
  },
});

const readyWork = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/ready-work",
  summary: "Minimal ready-work listing for a project",
  description:
    "Open issues that are not Needs input and have no live active session, evaluated in database time. Needs no claim; a full board is out of scope.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The ready issues",
      content: { "application/json": { schema: IssuesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in, or the agent key is invalid or revoked"),
    403: problem("Read access is required to list ready work"),
    404: problem("No such project is in scope for the caller"),
  },
});

export const routes = [
  claim,
  renew,
  progress,
  stop,
  requestStop,
  resume,
  reacquire,
  current,
  all,
  readyWork,
];

const statusFor = {
  not_signed_in: 401,
  issue_not_found: 404,
  project_not_found: 404,
  run_not_found: 404,
  insufficient_access: 403,
  issue_claimed: 409,
  issue_needs_input: 409,
  issue_blocked: 409,
  session_required: 409,
  agents_cannot_request_stop: 403,
  session_not_active: 409,
} as const satisfies Record<SessionsErrorKind, number>;

function isKind<K extends readonly SessionsErrorKind[]>(
  error: SessionsError,
  kinds: K,
): error is SessionsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

// The kinds array narrows the problem status for each route, so a route declares exactly
// the failures it can produce (the same pattern as projects/rest.ts).
function failure<K extends readonly SessionsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (isAgentError(error)) {
    return problemResponse(c, { status: 401, code: error.kind, title: error.message });
  }
  if (error instanceof SessionsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

const claimKinds = [
  "not_signed_in",
  "issue_not_found",
  "run_not_found",
  "insufficient_access",
  "issue_claimed",
  "issue_needs_input",
] as const;
const writeKinds = [
  "not_signed_in",
  "issue_not_found",
  "insufficient_access",
  "session_required",
] as const;
const stopRequestKinds = [
  "not_signed_in",
  "agents_cannot_request_stop",
  "issue_not_found",
  "insufficient_access",
  "session_not_active",
] as const;
const resumeKinds = [
  "not_signed_in",
  "issue_not_found",
  "run_not_found",
  "insufficient_access",
] as const;
const reacquireKinds = [
  "not_signed_in",
  "issue_not_found",
  "run_not_found",
  "insufficient_access",
  "issue_claimed",
  "issue_blocked",
  "session_required",
] as const;
const currentKinds = writeKinds;
const listKinds = ["not_signed_in", "issue_not_found", "insufficient_access"] as const;
const readyKinds = ["not_signed_in", "project_not_found", "insufficient_access"] as const;

export function createSessionsRest(
  service: SessionsService,
  sessionReader: SessionReader,
  authenticate: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  // One actor path for reads: a bearer key acts as an agent, otherwise a browser session
  // acts as a human. Mutations pass the agent identity directly; a missing key becomes a
  // SessionsError in the service rather than silently falling back to a cookie.
  const workActor = async (c: Context): Promise<WorkActor | null> => {
    const identity = await authenticate(c.req.raw);
    if (identity !== null) return { kind: "agent", identity };
    const account = await sessionReader(c);
    return account === null ? null : { kind: "human", account };
  };
  const agentActor = async (c: Context) => {
    const identity = await authenticate(c.req.raw);
    return identity === null ? null : { kind: "agent" as const, identity };
  };

  app.openapi(claim, async (c) => {
    try {
      return c.json(
        await service.claim(await agentActor(c), {
          issueId: c.req.valid("param").issueId,
          runId: c.req.valid("json").runId,
        }),
        201,
      );
    } catch (error) {
      return failure(c, error, claimKinds);
    }
  });

  app.openapi(renew, async (c) => {
    try {
      return c.json(
        await service.renew(
          await agentActor(c),
          c.req.valid("param").issueId,
          c.req.valid("json")?.sessionId,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, writeKinds);
    }
  });

  app.openapi(progress, async (c) => {
    try {
      return c.json(
        await service.progress(
          await agentActor(c),
          c.req.valid("param").issueId,
          c.req.valid("json").summary,
          c.req.valid("json").sessionId,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, writeKinds);
    }
  });

  app.openapi(stop, async (c) => {
    try {
      return c.json(
        await service.stop(
          await agentActor(c),
          c.req.valid("param").issueId,
          c.req.valid("json").outcome,
          c.req.valid("json").sessionId,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, writeKinds);
    }
  });

  app.openapi(requestStop, async (c) => {
    try {
      return c.json(
        await service.requestStop(
          await workActor(c),
          c.req.valid("param").issueId,
          c.req.valid("json")?.reason,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, stopRequestKinds);
    }
  });

  app.openapi(resume, async (c) => {
    try {
      return c.json(
        await service.resume(await agentActor(c), {
          issueId: c.req.valid("param").issueId,
          runId: c.req.valid("json").runId,
        }),
        200,
      );
    } catch (error) {
      return failure(c, error, resumeKinds);
    }
  });

  app.openapi(reacquire, async (c) => {
    try {
      return c.json(
        await service.reacquire(await agentActor(c), {
          issueId: c.req.valid("param").issueId,
          runId: c.req.valid("json").runId,
        }),
        201,
      );
    } catch (error) {
      return failure(c, error, reacquireKinds);
    }
  });

  app.openapi(current, async (c) => {
    try {
      return c.json(
        await service.getSession(await workActor(c), c.req.valid("param").issueId),
        200,
      );
    } catch (error) {
      return failure(c, error, currentKinds);
    }
  });

  app.openapi(all, async (c) => {
    try {
      return c.json(
        await service.listSessions(await workActor(c), c.req.valid("param").issueId),
        200,
      );
    } catch (error) {
      return failure(c, error, listKinds);
    }
  });

  app.openapi(readyWork, async (c) => {
    try {
      return c.json(
        await service.readyWork(await workActor(c), c.req.valid("param").projectId),
        200,
      );
    } catch (error) {
      return failure(c, error, readyKinds);
    }
  });

  return app;
}
