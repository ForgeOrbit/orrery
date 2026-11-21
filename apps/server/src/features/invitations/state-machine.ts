import type { InvitationDelivery, InvitationStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

export const invitationMachine = defineStateMachine<InvitationStatus>("Invitation", {
  pending: ["accepted", "declined", "expired", "revoked"],
  accepted: [],
  declined: [],
  expired: [],
  revoked: [],
});

export type InvitationDeliveryLifecycle = "unknown" | InvitationDelivery;

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

export function supersedeTargetForPending(live: boolean): "revoked" | "expired" {
  return live
    ? invitationMachine.assertTransition("pending", "revoked") === "revoked"
      ? "revoked"
      : "expired"
    : invitationMachine.assertTransition("pending", "expired") === "expired"
      ? "expired"
      : "revoked";
}
