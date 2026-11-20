import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  Agent,
  AgentIdentity,
  AgentIdentityQuery,
  AgentsResponse,
  AgentKeysResponse,
  CreateAgentKeyRequest,
  CreateAgentKeyResponse,
  CreateAgentRequest,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { AgentsError, type AgentsErrorKind, type AgentsService } from "./service.ts";

const createAgent = createRoute({
  method: "post",
  path: "/api/agents",
  summary: "Register an agent under the signed-in human's identity",
  description:
    "An agent is an accountable worker identity, distinct from any model or run. Several keys and clients can act as the same agent. Only its human owner can register or list agents.",
  request: {
    body: { required: true, content: { "application/json": { schema: CreateAgentRequest } } },
  },
  responses: {
    201: {
      description: "The registered agent",
      content: { "application/json": { schema: Agent } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    409: problem("You already have an agent with this name"),
  },
});

const listAgents = createRoute({
  method: "get",
  path: "/api/agents",
  summary: "List the signed-in human's agents",
  responses: {
    200: { description: "The agents", content: { "application/json": { schema: AgentsResponse } } },
    401: problem("Not signed in"),
  },
});

const issueKey = createRoute({
  method: "post",
  path: "/api/agents/keys",
  summary: "Issue a workspace-scoped API key for one agent",
  description:
    "The key is bound to exactly one workspace and the selected projects, with a level capped by the human owner's current access. Offer 7, 14, 30, 60, or 90 days, or Never; 90 days is the default. The secret is returned in this response only: only its hash is persisted, and no later read can recover it. Revocation is a separate control.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateAgentKeyRequest } },
    },
  },
  responses: {
    201: {
      description: "The issued key and its secret, shown once",
      content: { "application/json": { schema: CreateAgentKeyResponse } },
    },
    400: problem("A project is outside the workspace, or above your current access"),
    401: problem("Not signed in"),
    404: problem("No such agent, or no access to the workspace"),
  },
});

const listKeys = createRoute({
  method: "get",
  path: "/api/agents/keys",
  summary: "List the signed-in human's keys, optionally in one workspace",
  description:
    "Keys are listed without their secrets. An owner also has a separate, workspace-scoped view of every key in their workspace, including keys issued by other humans.",
  request: { query: z.object({ workspaceId: z.string().min(1).optional() }) },
  responses: {
    200: {
      description: "The keys",
      content: { "application/json": { schema: AgentKeysResponse } },
    },
    401: problem("Not signed in"),
  },
});

const keyParams = z.object({ keyId: z.string().min(1).max(200) });

const revokeKey = createRoute({
  method: "delete",
  path: "/api/agents/keys/{keyId}",
  summary: "Revoke one of the human's own keys",
  description:
    "Revocation takes effect on the next request, including for a Never key. The secret is neither required nor returned.",
  request: { params: keyParams },
  responses: {
    204: { description: "The key was revoked" },
    401: problem("Not signed in"),
    404: problem("No such key belongs to you"),
  },
});

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const workspaceKeyParams = z.object({
  workspaceId: z.string().min(1).max(200),
  keyId: z.string().min(1).max(200),
});

const workspaceKeys = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/agent-keys",
  summary: "List every key scoped to a workspace (owner only)",
  description:
    "A workspace owner sees all keys scoped to the workspace, whoever issued them, without any secret. Keys in other workspaces are never included.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace's keys",
      content: { "application/json": { schema: AgentKeysResponse } },
    },
    401: problem("Not signed in"),
    403: problem("Only a workspace owner can list these keys"),
  },
});

const ownerRevokeKey = createRoute({
  method: "delete",
  path: "/api/workspaces/{workspaceId}/agent-keys/{keyId}",
  summary: "Revoke any key scoped to a workspace (owner only)",
  description:
    "A workspace owner can revoke any key scoped to that workspace without seeing its secret. The workspace is part of the key lookup, so a key in another workspace cannot be affected. A non-owner answers 403.",
  request: { params: workspaceKeyParams },
  responses: {
    204: { description: "The key was revoked" },
    401: problem("Not signed in"),
    403: problem("Only a workspace owner can revoke these keys"),
    404: problem("No such key in this workspace"),
  },
});

const identity = createRoute({
  method: "get",
  path: "/api/agents/me",
  summary: "Resolve the agent behind a bearer API key",
  description:
    "Authenticates an `Authorization: Bearer <key>` header and returns the agent identity, the one workspace the key is scoped to, and the effective project access after the human owner's current access has capped the key's grants. An optional `workspaceId` or `projectId` makes a cross-workspace or out-of-scope request fail here, on the server. Revoked, expired, and inactive-owner keys fail; Never skips only the expiry check. The secret is never echoed.",
  request: { query: AgentIdentityQuery },
  responses: {
    200: {
      description: "The agent identity and its effective access",
      content: { "application/json": { schema: AgentIdentity } },
    },
    401: problem("The key is invalid, revoked, expired, or its owner is inactive"),
    403: problem("The key is not scoped to this workspace or project"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [
  createAgent,
  listAgents,
  issueKey,
  listKeys,
  revokeKey,
  workspaceKeys,
  ownerRevokeKey,
  identity,
];

const statusFor = {
  not_signed_in: 401,
  agent_name_taken: 409,
  agent_not_found: 404,
  workspace_not_found: 404,
  not_workspace_owner: 403,
  key_not_found: 404,
  invalid_key_grant: 400,
  invalid_key: 401,
  key_revoked: 401,
  key_expired: 401,
  key_owner_inactive: 401,
  key_out_of_scope: 403,
  insufficient_agent_access: 403,
} as const satisfies Record<AgentsErrorKind, number>;

function isKind<K extends readonly AgentsErrorKind[]>(
  error: AgentsError,
  kinds: K,
): error is AgentsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

// A route answers exactly the kinds it declares. Anything else stays a 500 instead of
// silently gaining a status.
function failure<K extends readonly AgentsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof AgentsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

const sessionKinds = ["not_signed_in"] as const;
const createKinds = ["not_signed_in", "agent_name_taken"] as const;
const issueKinds = [
  "not_signed_in",
  "agent_not_found",
  "workspace_not_found",
  "invalid_key_grant",
] as const;
const keyKinds = ["not_signed_in", "key_not_found"] as const;
const ownerKinds = ["not_signed_in", "not_workspace_owner"] as const;
const ownerRevokeKinds = ["not_signed_in", "not_workspace_owner", "key_not_found"] as const;
const identityKinds = [
  "invalid_key",
  "key_revoked",
  "key_expired",
  "key_owner_inactive",
  "key_out_of_scope",
  "insufficient_agent_access",
] as const;

// A bearer key is a transport detail of this feature: the header is read here, and the
// service alone decides whether the key authenticates. No other feature learns how the
// header is spelled.
export type AgentKeyReader = (c: Context) => string | null;

export function createAgentKeyReader(): AgentKeyReader {
  return (c) => {
    const header = c.req.header("Authorization");
    if (header === undefined) return null;
    return /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? null;
  };
}

// Thin: validate, call the service, map the result. The service decides who may do what.
export function createAgentsRest(service: AgentsService, sessionReader: SessionReader) {
  const readKey = createAgentKeyReader();
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(createAgent, async (c) => {
    try {
      return c.json(await service.createAgent(await sessionReader(c), c.req.valid("json")), 201);
    } catch (error) {
      return failure(c, error, createKinds);
    }
  });

  app.openapi(listAgents, async (c) => {
    try {
      return c.json({ agents: await service.listAgents(await sessionReader(c)) }, 200);
    } catch (error) {
      return failure(c, error, sessionKinds);
    }
  });

  app.openapi(issueKey, async (c) => {
    try {
      return c.json(await service.issueKey(await sessionReader(c), c.req.valid("json")), 201);
    } catch (error) {
      return failure(c, error, issueKinds);
    }
  });

  app.openapi(listKeys, async (c) => {
    try {
      const query = c.req.valid("query");
      return c.json(
        { keys: await service.listKeys(await sessionReader(c), query.workspaceId) },
        200,
      );
    } catch (error) {
      return failure(c, error, sessionKinds);
    }
  });

  app.openapi(revokeKey, async (c) => {
    try {
      await service.revokeKey(await sessionReader(c), c.req.valid("param").keyId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, keyKinds);
    }
  });

  app.openapi(workspaceKeys, async (c) => {
    try {
      return c.json(
        {
          keys: await service.workspaceKeys(
            await sessionReader(c),
            c.req.valid("param").workspaceId,
          ),
        },
        200,
      );
    } catch (error) {
      return failure(c, error, ownerKinds);
    }
  });

  app.openapi(ownerRevokeKey, async (c) => {
    try {
      const { workspaceId, keyId } = c.req.valid("param");
      await service.ownerRevokeKey(await sessionReader(c), workspaceId, keyId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, ownerRevokeKinds);
    }
  });

  app.openapi(identity, async (c) => {
    const token = readKey(c);
    if (token === null) {
      return problemResponse(c, {
        status: 401,
        code: "invalid_key",
        title: "The API key is not valid.",
      });
    }
    try {
      return c.json(await service.authenticate(token, c.req.valid("query")), 200);
    } catch (error) {
      return failure(c, error, identityKinds);
    }
  });

  return app;
}
