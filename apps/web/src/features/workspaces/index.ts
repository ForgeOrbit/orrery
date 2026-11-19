// Public interface of the workspaces feature in the web app. Routes and other features
// import only this file.
export {
  acceptWorkspaceInvitation,
  appointWorkspaceOwner,
  createWorkspace,
  inviteWorkspaceMember,
  registerThroughWorkspaceInvitation,
  updateWorkspaceMember,
} from "./commands.ts";
export {
  workspaceInvitationPreviewQuery,
  workspaceMembersQuery,
  workspaceQuery,
  workspacesQuery,
} from "./queries.ts";
