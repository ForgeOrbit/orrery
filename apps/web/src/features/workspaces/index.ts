// Public interface of the workspaces feature in the web app. Routes and other features
// import only this file.
export {
  acceptWorkspaceInvitation,
  appointWorkspaceOwner,
  createWorkspace,
  declineWorkspaceInvitation,
  inviteWorkspaceMember,
  registerThroughWorkspaceInvitation,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
} from "./commands.ts";
export {
  workspaceInvitationPreviewQuery,
  workspaceInvitationsQuery,
  workspaceMembersQuery,
  workspaceQuery,
  workspacesQuery,
} from "./queries.ts";
