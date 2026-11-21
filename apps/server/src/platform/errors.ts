const MAX_CAUSE_DEPTH = 10;

export function rootCause(error: unknown): Error | undefined {
  let current = error instanceof Error ? error : undefined;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current?.cause instanceof Error; depth++) {
    current = current.cause;
  }
  return current;
}

export interface ErrorSummary {
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

export function errorNameAndCode(error: unknown): { error: string; code?: string } {
  const code = stringField(error instanceof Error ? error : {}, "code");
  return {
    error: error instanceof Error ? error.name : typeof error,
    ...(code === undefined ? {} : { code }),
  };
}
