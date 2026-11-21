import type { AgentKeyValidity } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

export type AgentKeyState = "active" | "expired" | "revoked";

export const agentKeyMachine = defineStateMachine<AgentKeyState>("AgentKey", {
  active: ["expired", "revoked"],
  expired: ["revoked"],
  revoked: [],
});

export function effectiveAgentKeyState(input: {
  revokedAt: Date | null;
  validity: AgentKeyValidity;
  expired: boolean;
}): AgentKeyState {
  if (input.revokedAt !== null) return "revoked";
  if (input.validity !== "never" && input.expired) return "expired";
  return "active";
}

export function canAuthenticateKey(state: AgentKeyState): boolean {
  return state === "active";
}

export function canRotateKey(state: AgentKeyState): boolean {
  return state === "active";
}
