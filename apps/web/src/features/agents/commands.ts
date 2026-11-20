import {
  Agent,
  CreateAgentKeyResponse,
  type CreateAgentKeyRequest,
  type RotateAgentKeyRequest,
} from "@orrery/contract";
import { deleteRequest, postJson } from "../../lib/api.ts";

// Mutations for agents and their keys. The issue response is the only one that ever
// carries a secret, and the UI shows it once before discarding it.

export function createAgent(name: string): Promise<Agent> {
  return postJson("/api/agents", { name }, (value) => Agent.parse(value));
}

export function issueAgentKey(input: CreateAgentKeyRequest): Promise<CreateAgentKeyResponse> {
  return postJson("/api/agents/keys", input, (value) => CreateAgentKeyResponse.parse(value));
}

// Rotation keeps the agent usable while a client switches keys. Only the replacement's
// secret is returned; the source key's secret is never fetched or shown again.
export function rotateAgentKey(
  keyId: string,
  input: RotateAgentKeyRequest = {},
): Promise<CreateAgentKeyResponse> {
  return postJson(`/api/agents/keys/${encodeURIComponent(keyId)}/rotate`, input, (value) =>
    CreateAgentKeyResponse.parse(value),
  );
}

export function revokeAgentKey(keyId: string): Promise<void> {
  return deleteRequest(`/api/agents/keys/${encodeURIComponent(keyId)}`);
}

export function ownerRevokeAgentKey(workspaceId: string, keyId: string): Promise<void> {
  return deleteRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-keys/${encodeURIComponent(keyId)}`,
  );
}
