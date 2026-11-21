import { z } from "zod";
import { Email, Timestamp } from "./common.ts";







export const InstallationWorkspaceMember = z
  .object({
    humanId: z.string(),
    email: Email,
    isOwner: z.boolean(),
    isFormerOwner: z.boolean(),
    suspendedAt: Timestamp.nullable(),
    accountDeactivated: z.boolean(),
  })
  .meta({ id: "InstallationWorkspaceMember" });
export type InstallationWorkspaceMember = z.infer<typeof InstallationWorkspaceMember>;

export const InstallationWorkspace = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("shared"),
    createdAt: Timestamp,
    hasActiveOwner: z.boolean(),
    members: z.array(InstallationWorkspaceMember),
  })
  .meta({ id: "InstallationWorkspace" });
export type InstallationWorkspace = z.infer<typeof InstallationWorkspace>;


export const InstallationDirectoryResponse = z
  .array(InstallationWorkspace)
  .meta({ id: "InstallationDirectoryResponse" });
export type InstallationDirectoryResponse = z.infer<typeof InstallationDirectoryResponse>;

export const RecoverOwnershipRequest = z
  .object({ humanId: z.string().min(1).max(200) })
  .meta({ id: "RecoverOwnershipRequest" });
export type RecoverOwnershipRequest = z.infer<typeof RecoverOwnershipRequest>;



export const OwnershipRecovery = z
  .object({
    workspaceId: z.string(),
    humanId: z.string(),
    email: Email,
    recoveredAt: Timestamp,
  })
  .meta({ id: "OwnershipRecovery" });
export type OwnershipRecovery = z.infer<typeof OwnershipRecovery>;
