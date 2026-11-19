import {
  Workspace,
  WorkspaceInvitationPreview,
  WorkspaceMembersResponse,
  WorkspacesResponse,
} from "@orrery/contract";
import type { Workspace as WorkspaceResource } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

// Query definitions for this feature, shared by routes and components so they use one
// cache key. Responses are parsed with the contract's zod schemas, so a server change
// can't slip through.

export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: async (): Promise<WorkspaceResource[]> => {
    const res = await fetch("/api/workspaces");
    // No cookie or an expired session is a normal state, not an error.
    if (res.status === 401) return [];
    if (!res.ok) throw new Error(`Workspaces check failed (${res.status}).`);
    return WorkspacesResponse.parse(await res.json());
  },
});

export const workspaceQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}`, (value) =>
        Workspace.parse(value),
      ),
  });

export const workspaceMembersQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "members"],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, (value) =>
        WorkspaceMembersResponse.parse(value),
      ),
  });

export const workspaceInvitationPreviewQuery = (token: string) =>
  queryOptions({
    queryKey: ["workspace-invitation", token],
    queryFn: () =>
      getJson(`/api/workspace-invitations/preview?token=${encodeURIComponent(token)}`, (value) =>
        WorkspaceInvitationPreview.parse(value),
      ),
  });
