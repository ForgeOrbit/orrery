import type { TransferAuthorizationStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

// Explicit Project Transfer Authorization state machine
// (verified by docs/formal/ProjectTransfer.tla).
export const transferAuthorizationMachine = defineStateMachine<TransferAuthorizationStatus>(
  "TransferAuthorization",
  {
    pending: ["accepted", "revoked", "expired"],
    accepted: [],
    revoked: [],
    expired: [],
  },
);

export function effectiveTransferAuthorizationStatus(
  stored: TransferAuthorizationStatus,
  expired: boolean,
): TransferAuthorizationStatus {
  if (stored === "pending" && expired) return "expired";
  return stored;
}

export function canAcceptTransferAuthorization(
  stored: TransferAuthorizationStatus,
  expired: boolean,
): boolean {
  return effectiveTransferAuthorizationStatus(stored, expired) === "pending";
}
