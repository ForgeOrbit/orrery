import { z } from "zod";
import { Email, NewPassword, WorkspaceKind } from "./common.ts";
import { InvitationStatus } from "./invitations.ts";

// Workspaces and their members (issue #24). A human's personal workspace is private;
// shared workspaces are joined by invitation and have one or more owners. The listing is
// scoped to the caller's own access: another person's personal workspace never appears
// in it, not even for a system administrator.

// A workspace the signed-in account can access. `isOwner` is true for the owner of a
// personal workspace and for each owner of a shared one; it is what lets a client show
// owner-only actions without a second request. `canCreateProjects` is the caller's
// effective Create projects capability: owners always have it, and a member has it only
// when granted. It never grants access to an existing project by itself.
export const Workspace = z
  .object({
    id: z.string(),
    kind: WorkspaceKind,
    name: z.string(),
    isOwner: z.boolean(),
    canCreateProjects: z.boolean(),
  })
  .meta({ id: "Workspace" });
export type Workspace = z.infer<typeof Workspace>;

export const WorkspacesResponse = z.array(Workspace).meta({ id: "WorkspacesResponse" });
export type WorkspacesResponse = z.infer<typeof WorkspacesResponse>;

// Shared workspaces are created by a signed-in human, who becomes their first owner.
export const CreateWorkspaceRequest = z
  .object({
    name: z.string().trim().min(1, "Name the workspace.").max(120),
  })
  .meta({ id: "CreateWorkspaceRequest" });
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

// A member of a shared workspace, as owner management reads it. The email is the
// account's normalized address; the id is the stable identity an owner action targets.
export const WorkspaceMember = z
  .object({
    humanId: z.string(),
    email: Email,
    isOwner: z.boolean(),
    // The effective capability: an owner can always create, whatever the stored grant.
    canCreateProjects: z.boolean(),
  })
  .meta({ id: "WorkspaceMember" });
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;

// Owners grant one workspace capability at a time here. #28 adds the other three and the
// delegation ceilings; in this slice an owner grants Create projects directly.
export const UpdateWorkspaceMemberRequest = z
  .object({
    canCreateProjects: z.boolean(),
  })
  .meta({ id: "UpdateWorkspaceMemberRequest" });
export type UpdateWorkspaceMemberRequest = z.infer<typeof UpdateWorkspaceMemberRequest>;

export const WorkspaceMembersResponse = z
  .array(WorkspaceMember)
  .meta({ id: "WorkspaceMembersResponse" });
export type WorkspaceMembersResponse = z.infer<typeof WorkspaceMembersResponse>;

// An owner invites one email into the workspace. An existing account accepts the
// membership; a new email registers through the same link. The offered access is
// membership (owners appoint ownership separately).
export const InviteWorkspaceMemberRequest = z
  .object({
    email: Email,
  })
  .meta({ id: "InviteWorkspaceMemberRequest" });
export type InviteWorkspaceMemberRequest = z.infer<typeof InviteWorkspaceMemberRequest>;

// The invitation as its inviter sees it. The token travels by email only; it never
// appears in a response.
export const WorkspaceInvitation = z
  .object({
    workspaceId: z.string(),
    email: Email,
    status: InvitationStatus,
  })
  .meta({ id: "WorkspaceInvitation" });
export type WorkspaceInvitation = z.infer<typeof WorkspaceInvitation>;

// What the invitation link shows before anything is accepted: the workspace and the
// address it was sent to. A GET never consumes the token, and it works before sign-in
// because holding the link is how the recipient arrives.
export const WorkspaceInvitationPreview = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    email: Email,
  })
  .meta({ id: "WorkspaceInvitationPreview" });
export type WorkspaceInvitationPreview = z.infer<typeof WorkspaceInvitationPreview>;

// The token carried by a workspace invitation link. Emailed tokens are base64url, so the
// shape is fixed here once for the REST body, the preview query, and the web route. A
// malformed or overlong value is an invalid link, not a server failure.
export const WorkspaceInvitationToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,1024}$/)
  .meta({ id: "WorkspaceInvitationToken" });
export type WorkspaceInvitationToken = z.infer<typeof WorkspaceInvitationToken>;

// Redeems a workspace invitation as the signed-in account. The account's verified email
// must equal the invited address; a forwarded link cannot attach the membership to
// another account.
export const AcceptWorkspaceInvitationRequest = z
  .object({
    token: WorkspaceInvitationToken,
  })
  .meta({ id: "AcceptWorkspaceInvitationRequest" });
export type AcceptWorkspaceInvitationRequest = z.infer<typeof AcceptWorkspaceInvitationRequest>;

// Redeems the same link for an address that has no account yet, choosing a password.
// The account, its personal workspace, and this membership are created in one flow.
export const RegisterThroughWorkspaceInvitationRequest = z
  .object({
    token: WorkspaceInvitationToken,
    password: NewPassword,
  })
  .meta({ id: "RegisterThroughWorkspaceInvitationRequest" });
export type RegisterThroughWorkspaceInvitationRequest = z.infer<
  typeof RegisterThroughWorkspaceInvitationRequest
>;

// Appoints an existing member as another owner. The human id is the stable member
// identity; the caller must already be an owner.
export const AppointWorkspaceOwnerRequest = z
  .object({
    humanId: z.string().min(1).max(200),
  })
  .meta({ id: "AppointWorkspaceOwnerRequest" });
export type AppointWorkspaceOwnerRequest = z.infer<typeof AppointWorkspaceOwnerRequest>;
