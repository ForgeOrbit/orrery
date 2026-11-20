import { z } from "zod";
import { ProjectAccessLevel } from "./projects.ts";
import { Timestamp } from "./common.ts";

// Agent identities and the bearer keys that authenticate them (issue #30, #20 user
// stories 40-46). An agent is owned by one human; a key binds that agent to exactly one
// workspace and a selected set of projects. The raw secret is returned once, at issue
// time, and is never part of any stored or listed resource.

// The offered lifetimes, in days. "never" means the key has no expiry, but it is still
// subject to every access check (revocation, and the human owner's current access).
export const AgentKeyValidity = z
  .enum(["7", "14", "30", "60", "90", "never"])
  .meta({ id: "AgentKeyValidity" });
export type AgentKeyValidity = z.infer<typeof AgentKeyValidity>;

// Credential lifecycle events. No secret is ever stored on an event. Rotation writes
// one `agent_key_rotated` event on the replacement key; the new key's `replacesKeyId`
// names the source key without ever naming or re-showing its secret (#35).
export const AgentKeyEventType = z
  .enum(["agent_key_created", "agent_key_revoked", "agent_key_rotated"])
  .meta({ id: "AgentKeyEventType" });
export type AgentKeyEventType = z.infer<typeof AgentKeyEventType>;

export const Agent = z
  .object({
    id: z.string(),
    humanId: z.string(),
    name: z.string(),
    createdAt: Timestamp,
  })
  .meta({ id: "Agent" });
export type Agent = z.infer<typeof Agent>;

export const AgentsResponse = z.object({ agents: z.array(Agent) }).meta({ id: "AgentsResponse" });
export type AgentsResponse = z.infer<typeof AgentsResponse>;

export const CreateAgentRequest = z
  .object({ name: z.string().trim().min(1).max(120) })
  .meta({ id: "CreateAgentRequest" });
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

// One project grant on a key. The level is the ceiling requested for this project; the
// agent's effective level is the lower of this and the human owner's current level.
export const AgentKeyProject = z
  .object({ projectId: z.string(), projectName: z.string(), level: ProjectAccessLevel })
  .meta({ id: "AgentKeyProject" });
export type AgentKeyProject = z.infer<typeof AgentKeyProject>;

export const AgentKey = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    workspaceId: z.string(),
    createdByHumanId: z.string(),
    validity: AgentKeyValidity,
    createdAt: Timestamp,
    expiresAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
    revokedByHumanId: z.string().nullable(),
    // Set only on a replacement: the id of the key this one replaced. Ids are not
    // secrets, so the lineage is safe to show in listings and audit views (#35).
    replacesKeyId: z.string().nullable(),
    projects: z.array(AgentKeyProject),
  })
  .meta({ id: "AgentKey" });
export type AgentKey = z.infer<typeof AgentKey>;

export const AgentKeysResponse = z
  .object({ keys: z.array(AgentKey) })
  .meta({ id: "AgentKeysResponse" });
export type AgentKeysResponse = z.infer<typeof AgentKeysResponse>;

// The request names projects by id and level; the readable name is server-owned and
// only appears in responses, so a client cannot spoof a label.
export const AgentKeyGrant = z
  .object({ projectId: z.string(), level: ProjectAccessLevel })
  .meta({ id: "AgentKeyGrant" });
export type AgentKeyGrant = z.infer<typeof AgentKeyGrant>;

export const CreateAgentKeyRequest = z
  .object({
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    // Ninety days is the normal path; the default is applied here, once, for every
    // client (browser, REST, MCP).
    validity: AgentKeyValidity.default("90"),
    projects: z.array(AgentKeyGrant),
  })
  .meta({ id: "CreateAgentKeyRequest" });
export type CreateAgentKeyRequest = z.infer<typeof CreateAgentKeyRequest>;

// Rotation creates a replacement for one existing key (issue #35). Omitted fields are
// taken from the source key: its validity and its project grants. Explicit grants are
// validated exactly like issuance; preserved grants are re-capped by the human's current
// access. The replacement gets its own fresh expiry, independent of the source key.
export const RotateAgentKeyRequest = z
  .object({
    validity: AgentKeyValidity.optional(),
    projects: z.array(AgentKeyGrant).optional(),
  })
  .meta({ id: "RotateAgentKeyRequest" });
export type RotateAgentKeyRequest = z.infer<typeof RotateAgentKeyRequest>;

// The only response that ever carries the secret. It is not a stored resource and is
// shown exactly once, at issue or rotation time. On rotation it is the *new* secret;
// the source key's secret is never fetched, repeated, or logged.
export const CreateAgentKeyResponse = z
  .object({ key: AgentKey, secret: z.string() })
  .meta({ id: "CreateAgentKeyResponse" });
export type CreateAgentKeyResponse = z.infer<typeof CreateAgentKeyResponse>;

// What a bearer key authenticates: the agent identity, the one workspace the key is
// scoped to, and the effective project access after the human owner's current access
// has capped the key's grants. Optional query parameters on the identity route make a
// cross-workspace or out-of-scope request fail on the server, not in the client.
export const AgentIdentity = z
  .object({
    agentId: z.string(),
    name: z.string(),
    humanId: z.string(),
    keyId: z.string(),
    workspaceId: z.string(),
    validity: AgentKeyValidity,
    projects: z.array(AgentKeyProject),
  })
  .meta({ id: "AgentIdentity" });
export type AgentIdentity = z.infer<typeof AgentIdentity>;

export const AgentIdentityQuery = z
  .object({
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .meta({ id: "AgentIdentityQuery" });
export type AgentIdentityQuery = z.infer<typeof AgentIdentityQuery>;
