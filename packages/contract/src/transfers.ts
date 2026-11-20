import { z } from "zod";
import { Email, Timestamp, WorkspaceKind } from "./common.ts";
import { ProjectAccessLevel } from "./projects.ts";

// Project transfer between workspaces: personal-to-shared (#39) and shared-to-shared
// (#46). The schemas here are the shared language for the transfer preview, the source
// owner's authorization and the destination's acceptance. Transport adapters stay thin;
// the policy lives in the transfers service. Only humans perform a transfer: it is an
// ownership decision, not project work, so there is deliberately no MCP tool for it.

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

// The access a receiver can expect after the move. A personal project has no grants of
// its own; the destination owners and the receiver are the only new Manage grants.
export const TransferAccessChange = z
  .object({
    humanId: z.string(),
    email: Email,
    level: ProjectAccessLevel,
    reason: z.enum(["destination_owner", "receiver"]),
  })
  .meta({ id: "TransferAccessChange" });
export type TransferAccessChange = z.infer<typeof TransferAccessChange>;

// Live work is reported for confirmation; acceptance rechecks it in database time.
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

// Shown before confirmation: where the project goes, what visibility and access change,
// and whether any live work currently blocks the transfer. A #39 move makes a personal
// project shared; a #46 move keeps both sides shared but changes which workspace owns it.
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

export const CompleteTransferRequest = AuthorizeTransferRequest;
export type CompleteTransferRequest = AuthorizeTransferRequest;

export const AcceptTransferRequest = z
  .object({ token: z.string().min(1).max(512) })
  .meta({ id: "AcceptTransferRequest" });
export type AcceptTransferRequest = z.infer<typeof AcceptTransferRequest>;

// The resource returned when a source owner authorizes a transfer. The token is shown
// once; only its hash is stored. The receiver hands it back when accepting.
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
    // Null when the authorizer is not a member of the destination: a source owner can
    // hand over a token without learning the destination's name or its owners' identities.
    preview: TransferPreview.nullable(),
  })
  .meta({ id: "TransferAuthorization" });
export type TransferAuthorization = z.infer<typeof TransferAuthorization>;
