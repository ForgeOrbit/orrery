import {
  InvitationSummary,
  SessionResponse,
  Workspace,
  WorkspaceInvitation,
  WorkspaceMember,
  type AcceptWorkspaceInvitationRequest,
  type CreateWorkspaceRequest,
  type DeclineWorkspaceInvitationRequest,
  type InviteWorkspaceMemberRequest,
  type RegisterThroughWorkspaceInvitationRequest,
  type UpdateWorkspaceMemberRequest,
} from "@orrery/contract";
import { deleteRequest, patchJson, post, postJson, postNoContent } from "../../lib/api.ts";

export function createWorkspace(input: CreateWorkspaceRequest): Promise<Workspace> {
  return postJson("/api/workspaces", input, (value) => Workspace.parse(value));
}

export function inviteWorkspaceMember(
  workspaceId: string,
  input: InviteWorkspaceMemberRequest,
): Promise<WorkspaceInvitation> {
  return postJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
    input,
    (value) => WorkspaceInvitation.parse(value),
  );
}

export function acceptWorkspaceInvitation(
  input: AcceptWorkspaceInvitationRequest,
): Promise<Workspace> {
  return postJson("/api/workspace-invitations/acceptance", input, (value) =>
    Workspace.parse(value),
  );
}

export function appointWorkspaceOwner(
  workspaceId: string,
  humanId: string,
): Promise<WorkspaceMember> {
  return postJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/owners`,
    { humanId },
    (value) => WorkspaceMember.parse(value),
  );
}

export function updateWorkspaceMember(
  workspaceId: string,
  humanId: string,
  input: UpdateWorkspaceMemberRequest,
): Promise<WorkspaceMember> {
  return patchJson(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(humanId)}`,
    input,
    (value) => WorkspaceMember.parse(value),
  );
}

export function removeWorkspaceMember(workspaceId: string, humanId: string): Promise<void> {
  return deleteRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(humanId)}`,
  );
}

export function resendWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
): Promise<InvitationSummary> {
  return post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(
      invitationId,
    )}/resend`,
    (value) => InvitationSummary.parse(value),
  );
}

export function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
): Promise<InvitationSummary> {
  return post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(
      invitationId,
    )}/revoke`,
    (value) => InvitationSummary.parse(value),
  );
}

export function declineWorkspaceInvitation(
  input: DeclineWorkspaceInvitationRequest,
): Promise<void> {
  return postNoContent("/api/workspace-invitations/decline", input);
}

export function registerThroughWorkspaceInvitation(
  input: RegisterThroughWorkspaceInvitationRequest,
): Promise<SessionResponse> {
  return postJson("/api/workspace-invitations/registration", input, (value) =>
    SessionResponse.parse(value),
  );
}
