import { z } from "zod";
import { Email, Timestamp, WorkspaceKind } from "./common.ts";
import { ProjectAccessLevel, ProjectKey } from "./projects.ts";







export const TransferAuthorizationStatus = z
  .enum(["pending", "accepted", "revoked", "expired"])
  .meta({ id: "TransferAuthorizationStatus" });
export type TransferAuthorizationStatus = z.infer<typeof TransferAuthorizationStatus>;

export const TransferParty = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    kind: WorkspaceKind,
  })
  .meta({ id: "TransferParty" });
export type TransferParty = z.infer<typeof TransferParty>;



export const TransferAccessChange = z
  .object({
    humanId: z.string(),
    email: Email,
    level: ProjectAccessLevel,
    reason: z.enum(["destination_owner", "receiver"]),
  })
  .meta({ id: "TransferAccessChange" });
export type TransferAccessChange = z.infer<typeof TransferAccessChange>;


export const TransferActiveWork = z
  .object({
    count: z.int().nonnegative(),
    issues: z.array(
      z.object({
        issueId: z.string(),
        number: z.int().positive(),
        title: z.string(),
      }),
    ),
  })
  .meta({ id: "TransferActiveWork" });
export type TransferActiveWork = z.infer<typeof TransferActiveWork>;




export const TransferPreview = z
  .object({
    projectId: z.string(),
    projectName: z.string(),
    source: TransferParty,
    destination: TransferParty,
    visibilityChange: z.enum(["personal_to_shared", "shared_to_shared"]),
    accessChanges: z.array(TransferAccessChange),
    revokedSourceGrants: z.int().nonnegative(),
    activeWork: TransferActiveWork,
    ready: z.boolean(),
  })
  .meta({ id: "TransferPreview" });
export type TransferPreview = z.infer<typeof TransferPreview>;

export const AuthorizeTransferRequest = z
  .object({ destinationWorkspaceId: z.string().min(1).max(200) })
  .meta({ id: "AuthorizeTransferRequest" });
export type AuthorizeTransferRequest = z.infer<typeof AuthorizeTransferRequest>;



export const CompleteTransferRequest = AuthorizeTransferRequest.extend({
  key: ProjectKey.optional(),
}).meta({ id: "CompleteTransferRequest" });
export type CompleteTransferRequest = z.infer<typeof CompleteTransferRequest>;



export const AcceptTransferRequest = z
  .object({
    token: z.string().min(1).max(512),
    key: ProjectKey.optional(),
  })
  .meta({ id: "AcceptTransferRequest" });
export type AcceptTransferRequest = z.infer<typeof AcceptTransferRequest>;



export const TransferAuthorization = z
  .object({
    token: z.string(),
    authorizationId: z.string(),
    projectId: z.string(),
    sourceWorkspaceId: z.string(),
    destinationWorkspaceId: z.string(),
    authorizedByHumanId: z.string(),
    status: TransferAuthorizationStatus,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    
    
    preview: TransferPreview.nullable(),
  })
  .meta({ id: "TransferAuthorization" });
export type TransferAuthorization = z.infer<typeof TransferAuthorization>;
