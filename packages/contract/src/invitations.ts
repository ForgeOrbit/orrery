import { z } from "zod";
import { Email, NewPassword } from "./common.ts";

// Installation invitations (issue #23): a system administrator invites an email onto
// the installation. The emailed link carries a single-use token; following the link
// (GET) changes nothing, and only the recipient's POST — the password they chose —
// redeems it. Registration is invitation-only: there is no public sign-up.

// The lifecycle states an invitation records (#20 tracks them separately from email
// delivery and account verification). `expired` is set in place when a newer invitation
// supersedes one whose seven days passed (or whose email never left); time itself is
// still evaluated in database time at redemption. Decline and revoke arrive with #25.
export const InvitationStatus = z
  .enum(["pending", "accepted", "expired"])
  .meta({ id: "InvitationStatus" });
export type InvitationStatus = z.infer<typeof InvitationStatus>;

// Whether the invitation email actually left (#20: pending does not imply delivered).
// `sent` is the only state that may redeem; `failed` records a delivery the relay
// refused. Null means no attempt has been recorded yet — such an invitation never
// redeems either.
export const InvitationDelivery = z.enum(["sent", "failed"]).meta({ id: "InvitationDelivery" });
export type InvitationDelivery = z.infer<typeof InvitationDelivery>;

// The email a system administrator invites.
export const InviteInstallationRequest = z
  .object({
    email: Email,
  })
  .meta({ id: "InviteInstallationRequest" });
export type InviteInstallationRequest = z.infer<typeof InviteInstallationRequest>;

// The invitation as its inviter sees it. The token is a secret that travels by email
// only; it never appears in a response.
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
