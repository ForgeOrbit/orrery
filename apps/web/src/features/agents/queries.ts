import { AgentsResponse, AgentKeysResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

export const agentsQuery = queryOptions({
  queryKey: ["agents"],
  queryFn: () => getJson("/api/agents", (value) => AgentsResponse.parse(value).agents),
});

export const agentKeysQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["agents", "keys", workspaceId, "mine"],
    queryFn: () =>
      getJson(
        `/api/agents/keys?workspaceId=${encodeURIComponent(workspaceId)}`,
        (value) => AgentKeysResponse.parse(value).keys,
      ),
  });

export const workspaceAgentKeysQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["agents", "keys", workspaceId, "workspace"],
    queryFn: () =>
      getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-keys`,
        (value) => AgentKeysResponse.parse(value).keys,
      ),
  });
