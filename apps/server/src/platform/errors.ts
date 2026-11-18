// Error helpers shared by the HTTP layer and tests: drivers and ORMs wrap the
// interesting error, and some wrappers log more than they should.

// The root of a thrown error's cause chain: the driver or database error underneath
// whatever the ORM wrapped it in.
export function rootCause(error: unknown): Error | undefined {
  let current = error instanceof Error ? error : undefined;
  while (current?.cause instanceof Error) current = current.cause;
  return current;
}

// What to log about an unexpected error, as log fields. A database error's message can
// quote the input that broke it (for example a bad uuid), so an error carrying a
// Postgres SQLSTATE code logs its name and code only, never its message. Everything
// else keeps its message, which is usually the whole story.
export interface ErrorSummary {
  // The root error's name.
  error: string;
  code?: string;
  message?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function errorSummary(error: unknown): ErrorSummary {
  const root = rootCause(error);
  if (root === undefined) return { error: typeof error };
  if ("code" in root && typeof root.code === "string" && SQLSTATE.test(root.code)) {
    return { error: root.name, code: root.code };
  }
  return { error: root.name, message: root.message };
}
