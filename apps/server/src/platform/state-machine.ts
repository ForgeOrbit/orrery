export type TransitionTable<State extends string> = Readonly<Record<State, readonly State[]>>;

export class InvalidStateTransitionError extends Error {
  readonly machine: string;
  readonly from: string;
  readonly to: string;

  constructor(machine: string, from: string, to: string) {
    super(`Illegal ${machine} state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

export interface StateMachine<State extends string> {
  readonly name: string;
  readonly transitions: TransitionTable<State>;
  readonly states: readonly State[];
  readonly terminalStates: readonly State[];
  canTransition(from: State, to: State): boolean;
  assertTransition(from: State, to: State): State;
  isTerminal(state: State): boolean;
}

export function defineStateMachine<State extends string>(
  name: string,
  transitions: TransitionTable<State>,
): StateMachine<State> {
  const isState = (key: string): key is State => Object.hasOwn(transitions, key);
  const states = Object.keys(transitions).filter(isState);
  const terminalStates = states.filter((state) => transitions[state].length === 0);

  return {
    name,
    transitions,
    states,
    terminalStates,
    canTransition(from, to) {
      return transitions[from].includes(to);
    },
    assertTransition(from, to) {
      if (!transitions[from].includes(to)) {
        throw new InvalidStateTransitionError(name, from, to);
      }
      return to;
    },
    isTerminal(state) {
      return transitions[state].length === 0;
    },
  };
}
