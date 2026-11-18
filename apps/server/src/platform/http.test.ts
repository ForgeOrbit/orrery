import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "./db.ts";
import type { Feature } from "./feature.ts";
import { createApp } from "./http.ts";
import { createLogger, type Logger } from "./log.ts";

// A route that explodes, to prove createApp's error handling: one JSON log line and a
// 500 Problem, with no parameters, headers, or bodies in either.

const wrapped = createRoute({
  method: "get",
  path: "/wrapped",
  responses: { 200: { description: "Never reached" } },
});

// Shaped like a Drizzle wrapper: its message embeds query parameters, the cause is the
// driver's error with the real story.
const wrappedErrorFeature: Feature = {
  name: "wrappedError",
  rest: new OpenAPIHono().openapi(wrapped, () => {
    throw new Error("Failed query: insert into humans params: the-password-hash", {
      cause: new Error('violates check constraint "humans_email_normalized"'),
    });
  }),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const unhandledErrorLines = (lines: string[]) =>
  lines.flatMap((line) => {
    const entry: unknown = JSON.parse(line);
    return isRecord(entry) && entry.msg === "unhandled error" ? [entry] : [];
  });

const boom = createRoute({
  method: "get",
  path: "/boom",
  responses: { 200: { description: "Never reached" } },
});

const throwingFeature: Feature = {
  name: "throwing",
  rest: new OpenAPIHono().openapi(boom, () => {
    throw new Error("boom from the route");
  }),
};

const refused = createRoute({
  method: "get",
  path: "/refused",
  responses: { 415: { description: "The route said no" } },
});

const httpExceptionFeature: Feature = {
  name: "refused",
  rest: new OpenAPIHono().openapi(refused, () => {
    throw new HTTPException(415, { message: "Unsupported Media Type" });
  }),
};

// postgres.js connects lazily, so building the features never touches this address.
const database = createDb("postgres://unused@127.0.0.1:1/unused");
afterAll(() => void database.sql.end());

describe("createApp error handling", () => {
  it("maps an unhandled error to a 500 Problem and logs one JSON line", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const log = createLogger("info");
      const app = createApp({ features: [throwingFeature], publicUrl: "http://orrery.test", log });
      const res = await app.request("/boom");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: "Internal server error." });

      const unhandled = unhandledErrorLines(lines);
      expect(unhandled).toHaveLength(1);
      expect(unhandled[0]).toMatchObject({
        error: "Error",
        message: "boom from the route",
        method: "GET",
        path: "/boom",
      });
      // Only the decided fields: no params, headers, cookies, or bodies.
      expect(Object.keys(unhandled[0] ?? {}).toSorted()).toEqual(
        ["time", "level", "msg", "error", "message", "method", "path"].toSorted(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("lets an HTTPException's own response through, without logging an error", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const log: Logger = createLogger("info");
      const app = createApp({
        features: [httpExceptionFeature],
        publicUrl: "http://orrery.test",
        log,
      });
      const res = await app.request("/refused");
      expect(res.status).toBe(415);
      expect(lines.filter((line) => line.includes("unhandled error"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("logs the wrapped error's cause, never the wrapper's parameters", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      const log: Logger = createLogger("info");
      const app = createApp({
        features: [wrappedErrorFeature],
        publicUrl: "http://orrery.test",
        log,
      });
      const res = await app.request("/wrapped");
      expect(res.status).toBe(500);

      const unhandled = unhandledErrorLines(lines);
      expect(unhandled).toHaveLength(1);
      expect(unhandled[0]).toMatchObject({
        error: "Error",
        message: 'violates check constraint "humans_email_normalized"',
      });
      // The wrapper's message carried the parameters; they must not reach the log.
      expect(lines.join("\n")).not.toContain("the-password-hash");
    } finally {
      spy.mockRestore();
    }
  });
});
