import { describe, expect, it } from "vitest";
import { InvalidStateTransitionError, defineStateMachine } from "./state-machine.ts";

describe("defineStateMachine", () => {
  const machine = defineStateMachine<"idle" | "running" | "done">("Job", {
    idle: ["running"],
    running: ["running", "done"],
    done: [],
  });

  it("reports states and terminal states accurately", () => {
    expect(machine.states).toEqual(["idle", "running", "done"]);
    expect(machine.terminalStates).toEqual(["done"]);
    expect(machine.isTerminal("idle")).toBe(false);
    expect(machine.isTerminal("running")).toBe(false);
    expect(machine.isTerminal("done")).toBe(true);
  });

  it("permits declared transitions and rejects illegal ones", () => {
    expect(machine.canTransition("idle", "running")).toBe(true);
    expect(machine.canTransition("running", "done")).toBe(true);
    expect(machine.canTransition("idle", "done")).toBe(false);
    expect(machine.canTransition("done", "running")).toBe(false);

    expect(machine.assertTransition("idle", "running")).toBe("running");
    expect(() => machine.assertTransition("done", "idle")).toThrow(InvalidStateTransitionError);
  });
});
