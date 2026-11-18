import { describe, expect, it } from "vitest";
import { errorSummary, rootCause } from "./errors.ts";

// Shaped like a postgres.js error: a SQLSTATE plus the schema identifiers involved.
class PostgresShapedError extends Error {
  readonly code = "23514";
  readonly constraint_name = "humans_email_normalized";
  readonly table_name = "humans";
  readonly detail = "Failing row contains (id, Admin@Example.COM, scrypt$hash)";

  constructor() {
    super('new row violates check constraint "humans_email_normalized"');
    this.name = "PostgresError";
  }
}

describe("rootCause", () => {
  it("stops on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(rootCause(a)).toBeInstanceOf(Error);
  });
});

describe("errorSummary", () => {
  it("logs a Postgres error's code and identifiers, never its message or detail", () => {
    const summary = errorSummary(new Error("Failed query", { cause: new PostgresShapedError() }));
    expect(summary).toEqual({
      error: "PostgresError",
      code: "23514",
      constraint: "humans_email_normalized",
      table: "humans",
    });
    expect(JSON.stringify(summary)).not.toContain("scrypt$");
  });

  it("keeps the message of a system error whose code looks like a SQLSTATE", () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(errorSummary(error)).toEqual({ error: "Error", message: "write EPIPE" });
  });
});
