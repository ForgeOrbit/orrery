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
} from "@orrery/contract";
import { post, postJson, postNoContent } from "../../lib/api.ts";

// Mutations for this feature. Each posts JSON through the app's one request helper,
// which parses the response with the contract's schemas and turns a Problem (RFC 9457)
// response into a plain Error carrying its most specific human text.

// Creates a shared workspace; the server makes the caller its first owner.
export function createWorkspace(input: CreateWorkspaceRequest): Promise<Workspace> {
  return postJson("/api/workspaces", input, (value) => Workspace.parse(value));
}

// Invites one email into a shared workspace. The token travels by email only.
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

// Resend rotates the link for a current owner; the previous link stops working.
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

// Revoke ends a pending, unexpired offer. The history row stays.
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

// The recipient declines from the emailed link; holding the token is the capability.
export function declineWorkspaceInvitation(
  input: DeclineWorkspaceInvitationRequest,
): Promise<void> {
  return postNoContent("/api/workspace-invitations/decline", input);
}

// Accepts the emailed link as the signed-in account. The server enforces that the
// account's verified email is the invited address.
export function acceptWorkspaceInvitation(
  input: AcceptWorkspaceInvitationRequest,
): Promise<Workspace> {
  return postJson("/api/workspace-invitations/acceptance", input, (value) =>
    Workspace.parse(value),
  );
}

// Appoints an existing member as another owner. Owners only; the server decides.
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

// Registers a new account through the same link, creating its personal workspace and
// the membership in one server transaction.
export function registerThroughWorkspaceInvitation(
  input: RegisterThroughWorkspaceInvitationRequest,
): Promise<SessionResponse> {
  return postJson("/api/workspace-invitations/registration", input, (value) =>
    SessionResponse.parse(value),
  );
}
