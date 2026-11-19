import { z } from "zod";
import { Email, NewPassword } from "./common.ts";
import { ProjectAccessLevel } from "./projects.ts";

// Installation invitations (issue #23): a system administrator invites an email onto
// the installation. The emailed link carries a single-use token; following the link
// (GET) changes nothing, and only the recipient's POST — the password they chose —
// redeems it. Registration is invitation-only: there is no public sign-up.

// The lifecycle states an invitation records (#20 tracks them separately from email
// delivery and account verification). A pending invitation becomes accepted, declined,
// expired, or revoked, once, and never returns to pending. Expiry is evaluated in
// database time; resending keeps the old row in this history and issues a new one.
export const InvitationStatus = z
  .enum(["pending", "accepted", "declined", "expired", "revoked"])
  .meta({ id: "InvitationStatus" });
export type InvitationStatus = z.infer<typeof InvitationStatus>;

// Whether the invitation email actually left (#20: pending does not imply delivered).
// `sent` records a delivery the relay accepted; `failed` records one it refused and is
// the only state that never redeems. Null means no attempt has been recorded yet — a
// crash or a failed recording — and such an invitation may still redeem, because
// holding the token proves the email arrived. A null row past the grace window is
// superseded like an expired one.
export const InvitationDelivery = z.enum(["sent", "failed"]).meta({ id: "InvitationDelivery" });
export type InvitationDelivery = z.infer<typeof InvitationDelivery>;

// The email a system administrator invites.
export const InviteInstallationRequest = z
  .object({
    email: Email,
  })
  .meta({ id: "InviteInstallationRequest" });
export type InviteInstallationRequest = z.infer<typeof InviteInstallationRequest>;

// The invitation token from an installation invitation email. Emailed tokens are
// base64url, so the shape is fixed once for registration and decline. A malformed or
// overlong value is an invalid link, not a server failure.
export const InvitationToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,1024}$/)
  .meta({ id: "InvitationToken" });
export type InvitationToken = z.infer<typeof InvitationToken>;

// What an invitation offers. Project grants are the actual scope a workspace invitation
// can carry: each names a project that must still belong to the invited workspace when
// the offer is accepted.
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
      projectName: z.string(),
      level: ProjectAccessLevel,
    }),
  ])
  .meta({ id: "InvitationGrant" });
export type InvitationGrant = z.infer<typeof InvitationGrant>;

// The project access an owner offers in a workspace invitation. At acceptance every
// project is rechecked against the invited workspace before any grant is written.
export const WorkspaceInvitationProjectGrant = z
  .object({
    projectId: z.string().min(1).max(200),
    level: ProjectAccessLevel,
  })
  .meta({ id: "WorkspaceInvitationProjectGrant" });
export type WorkspaceInvitationProjectGrant = z.infer<typeof WorkspaceInvitationProjectGrant>;

// What the invitation targets: this installation, or one shared workspace.
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

// Delivery, separate from the lifecycle (#20): an invitation can be pending while its
// email never left, and the UI must show those as two facts. Null means no attempt has
// been recorded yet.
export const InvitationDeliveryState = z
  .object({
    status: InvitationDelivery.nullable(),
    attemptedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "InvitationDeliveryState" });
export type InvitationDeliveryState = z.infer<typeof InvitationDeliveryState>;

// One invitation as an inviter manages it: recipient, inviter, target, offered grants,
// lifecycle timestamps, and delivery, all in one record. The token is never included.
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

// The invitation as its inviter sees it right after sending it. The token is a secret
// that travels by email only; it never appears in a response.
export const InstallationInvitation = z
  .object({
    email: Email,
    status: InvitationStatus,
  })
  .meta({ id: "InstallationInvitation" });
export type InstallationInvitation = z.infer<typeof InstallationInvitation>;

// Redeems the invitation token from the email, with the password the recipient chose.
// The new account is bound to the invited email and starts verified, with its personal
// workspace. Single-use: the token is only ever consumed by this POST.
export const InvitationRegistrationRequest = z
  .object({
    token: z.string().min(1).max(1024),
    password: NewPassword,
  })
  .meta({ id: "InvitationRegistrationRequest" });
export type InvitationRegistrationRequest = z.infer<typeof InvitationRegistrationRequest>;

// The recipient declines from the emailed link. Holding the token is the capability;
// the POST changes the lifecycle and makes the link unusable.
export const DeclineInvitationRequest = z
  .object({
    token: InvitationToken,
  })
  .meta({ id: "DeclineInvitationRequest" });
export type DeclineInvitationRequest = z.infer<typeof DeclineInvitationRequest>;
