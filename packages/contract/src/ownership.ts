import { z } from "zod";
import { Email, Timestamp } from "./common.ts";

// Ownership recovery (#43). A system administrator can see a minimal installation
// directory of shared workspaces and appoint a new owner when none is active. The
// directory carries workspace identity, ownership and membership status only: it has no
// project ids, names, issues or knowledge, so an administrator role never becomes a
// back door into private workspace content. The promoted human is named in the request
// body; the acting administrator comes from the session and can never be the recipient.
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

// A bare list per ADR-0003: no envelope, and no fields beyond the directory above.
export const InstallationDirectoryResponse = z
  .array(InstallationWorkspace)
  .meta({ id: "InstallationDirectoryResponse" });
export type InstallationDirectoryResponse = z.infer<typeof InstallationDirectoryResponse>;

export const RecoverOwnershipRequest = z
  .object({ humanId: z.string().min(1).max(200) })
  .meta({ id: "RecoverOwnershipRequest" });
export type RecoverOwnershipRequest = z.infer<typeof RecoverOwnershipRequest>;

// The bare resource returned after a successful recovery. It names the workspace and
// the new owner, never a project or a credential.
export const OwnershipRecovery = z
  .object({
    workspaceId: z.string(),
    humanId: z.string(),
    email: Email,
    recoveredAt: Timestamp,
  })
  .meta({ id: "OwnershipRecovery" });
export type OwnershipRecovery = z.infer<typeof OwnershipRecovery>;
