import { z } from "zod";
import { Email, NewPassword } from "./common.ts";
import { ProjectAccessLevel } from "./projects.ts";










export const InvitationStatus = z
  .enum(["pending", "accepted", "declined", "expired", "revoked"])
  .meta({ id: "InvitationStatus" });
export type InvitationStatus = z.infer<typeof InvitationStatus>;







export const InvitationDelivery = z.enum(["sent", "failed"]).meta({ id: "InvitationDelivery" });
export type InvitationDelivery = z.infer<typeof InvitationDelivery>;


export const InviteInstallationRequest = z
  .object({
    email: Email,
  })
  .meta({ id: "InviteInstallationRequest" });
export type InviteInstallationRequest = z.infer<typeof InviteInstallationRequest>;




export const InvitationToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,1024}$/)
  .meta({ id: "InvitationToken" });
export type InvitationToken = z.infer<typeof InvitationToken>;




export const InvitationGrant = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("installation_account") }),
    z.object({
      kind: z.literal("workspace_membership"),
      workspaceId: z.string(),
      role: z.literal("member"),
    }),
    z.object({
      kind: z.literal("project_access"),
      projectId: z.string(),
      projectName: z.string().nullable().describe("Null when the project no longer belongs to the invited workspace."),
      level: ProjectAccessLevel,
    }),
  ])
  .meta({ id: "InvitationGrant" });
export type InvitationGrant = z.infer<typeof InvitationGrant>;



export const WorkspaceInvitationProjectGrant = z
  .object({
    projectId: z.string().min(1).max(200),
    level: ProjectAccessLevel,
  })
  .meta({ id: "WorkspaceInvitationProjectGrant" });
export type WorkspaceInvitationProjectGrant = z.infer<typeof WorkspaceInvitationProjectGrant>;


export const InvitationTarget = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("installation") }),
    z.object({
      kind: z.literal("workspace"),
      id: z.string(),
      name: z.string(),
    }),
  ])
  .meta({ id: "InvitationTarget" });
export type InvitationTarget = z.infer<typeof InvitationTarget>;




export const InvitationDeliveryState = z
  .object({
    status: InvitationDelivery.nullable(),
    attemptedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "InvitationDeliveryState" });
export type InvitationDeliveryState = z.infer<typeof InvitationDeliveryState>;



export const InvitationSummary = z
  .object({
    id: z.string(),
    email: Email,
    status: InvitationStatus,
    target: InvitationTarget,
    grants: z.array(InvitationGrant),
    invitedBy: z.object({ humanId: z.string(), email: Email }),
    delivery: InvitationDeliveryState,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    acceptedAt: z.iso.datetime().nullable(),
    declinedAt: z.iso.datetime().nullable(),
    expiredAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "InvitationSummary" });
export type InvitationSummary = z.infer<typeof InvitationSummary>;

export const InvitationSummaries = z
  .array(InvitationSummary)
  .meta({ id: "InvitationSummaries" });
export type InvitationSummaries = z.infer<typeof InvitationSummaries>;



export const InstallationInvitation = z
  .object({
    email: Email,
    status: InvitationStatus,
  })
  .meta({ id: "InstallationInvitation" });
export type InstallationInvitation = z.infer<typeof InstallationInvitation>;




export const InvitationRegistrationRequest = z
  .object({
    token: z.string().min(1).max(1024),
    password: NewPassword,
  })
  .meta({ id: "InvitationRegistrationRequest" });
export type InvitationRegistrationRequest = z.infer<typeof InvitationRegistrationRequest>;



export const DeclineInvitationRequest = z
  .object({
    token: InvitationToken,
  })
  .meta({ id: "DeclineInvitationRequest" });
export type DeclineInvitationRequest = z.infer<typeof DeclineInvitationRequest>;
