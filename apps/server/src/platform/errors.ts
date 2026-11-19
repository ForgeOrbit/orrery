// Error helpers shared by the HTTP layer and tests: drivers and ORMs wrap the
// interesting error, and some wrappers log more than they should.

// The root of a thrown error's cause chain: the driver or database error underneath
// whatever the ORM wrapped it in.
// Stops after a few links, so a cyclic cause chain cannot loop forever.
const MAX_CAUSE_DEPTH = 10;

export function rootCause(error: unknown): Error | undefined {
  let current = error instanceof Error ? error : undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current?.cause instanceof Error; depth++) {
    current = current.cause;
  }
  return current;
}

// What to log about an unexpected error, as log fields. A Postgres error's message can
// quote the input that broke it (for example a bad uuid), so it logs its name, SQLSTATE
// code and the schema identifiers involved (constraint, table, column), never its
// message or detail. Everything else keeps its message, which is usually the whole story.
export interface ErrorSummary {
  // The root error's name.
  error: string;
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  message?: string;
}

const stringField = (value: object, key: string): string | undefined => {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};

// The constraint name of a Postgres unique violation (SQLSTATE 23505), walking through
// driver and ORM wrappers, or undefined for anything else. Features translate a
// constraint into its own error: the constraint is the honest, stable reason.
export function uniqueConstraintName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== null && typeof current === "object" && depth < 3; depth++) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "23505") {
      const name = candidate.constraint ?? candidate.constraint_name;
      if (typeof name === "string") return name;
      return undefined;
    }
    current = candidate.cause;
  }
  return undefined;
}

export function errorSummary(error: unknown): ErrorSummary {
  const root = rootCause(error);
  if (root === undefined) return { error: typeof error };
  if (root.name === "PostgresError") {
    const summary: ErrorSummary = { error: root.name };
    const fields = [
      ["code", "code"],
      ["constraint", "constraint_name"],
      ["table", "table_name"],
      ["column", "column_name"],
    ] as const;
    for (const [name, key] of fields) {
      const value = stringField(root, key);
      if (value !== undefined) summary[name] = value;
    }
    return summary;
  }
  return { error: root.name, message: root.message };
}

// An error's code (ECONNREFUSED, EAUTH, ...), read without asserting a shape: errors
// arrive from drivers and libraries that each wrap them differently. For log fields:
// name and code only, so a wrapped error's message — which can quote what broke it —
// never reaches a log.
export function errorNameAndCode(error: unknown): { error: string; code?: string } {
  const code = stringField(error instanceof Error ? error : {}, "code");
  return {
    error: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }),
  };
}
