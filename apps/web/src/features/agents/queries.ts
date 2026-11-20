import { AgentsResponse, AgentKeysResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

// Queries for the agents feature. Agents are human-owned and workspace-independent;
// keys are scoped to one workspace. Secrets are never part of a listing.

export const agentsQuery = queryOptions({
  queryKey: ["agents"],
  queryFn: () => getJson("/api/agents", (value) => AgentsResponse.parse(value).agents),
});

// The signed-in human's keys in one workspace.
export const agentKeysQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["agents", "keys", workspaceId, "mine"],
    queryFn: () =>
      getJson(
        `/api/agents/keys?workspaceId=${encodeURIComponent(workspaceId)}`,
        (value) => AgentKeysResponse.parse(value).keys,
      ),
  });

// Every key in the workspace, owner only. This is the view an owner uses to revoke a
// key issued by someone else without ever seeing its secret.
export const workspaceAgentKeysQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["agents", "keys", workspaceId, "workspace"],
    queryFn: () =>
      getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-keys`,
        (value) => AgentKeysResponse.parse(value).keys,
      ),
  });
