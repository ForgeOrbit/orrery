import type { InvitationDelivery, InvitationStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

// Explicit Invitation lifecycle state machine (verified by docs/formal/InvitationLifecycle.tla).
// Shared by installation invitations and workspace invitations. Terminal states never revert.
export const invitationMachine = defineStateMachine<InvitationStatus>("Invitation", {
  pending: ["accepted", "declined", "expired", "revoked"],
  accepted: [],
  declined: [],
  expired: [],
  revoked: [],
});

export type InvitationDeliveryLifecycle = "unknown" | InvitationDelivery;

// Orthogonal delivery state machine: unknown (null in DB) transitions once to sent or failed,
// and only while the invitation itself is still pending.
export const invitationDeliveryMachine = defineStateMachine<InvitationDeliveryLifecycle>(
  "InvitationDelivery",
  {
    unknown: ["sent", "failed"],
    sent: [],
    failed: [],
  },
);

export type EffectiveInvitationState =
  | "pending_live"
  | "pending_undelivered"
  | "pending_expired"
  | "accepted"
  | "declined"
  | "expired"
  | "revoked";

// DB-time effective state of an invitation row combining lifecycle, expiry, and delivery.
export function effectiveInvitationState(input: {
  status: InvitationStatus;
  expired: boolean;
  deliveryStatus: InvitationDelivery | null;
  withinGraceWindow: boolean;
}): EffectiveInvitationState {
  if (input.status !== "pending") return input.status;
  if (input.expired) return "pending_expired";
  if (
    input.deliveryStatus === "failed" ||
    (input.deliveryStatus === null && !input.withinGraceWindow)
  ) {
    return "pending_undelivered";
  }
  return "pending_live";
}

export function canResendInvitation(status: InvitationStatus): boolean {
  return status === "pending" || status === "expired";
}

// When rotating or superseding a pending invitation: a still-live row is revoked; a row
// past its deadline is materialized as expired so it never claims to have expired in the future.
export function supersedeTargetForPending(live: boolean): "revoked" | "expired" {
  return live
    ? invitationMachine.assertTransition("pending", "revoked") === "revoked"
      ? "revoked"
      : "expired"
    : invitationMachine.assertTransition("pending", "expired") === "expired"
      ? "expired"
      : "revoked";
}
