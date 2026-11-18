import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { type ServerType, serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { Services } from "./service/index.ts";

const publicUrl = "http://orrery.test";

function appWith(ready: "ok" | "degraded") {
  const services: Services = {
    system: {
      health: () => ({ status: "ok", version: "test" }),
      ready: async () => ({ status: ready, version: "test" }),
    },
  };
  return createApp({ services, publicUrl });
}

describe("health", () => {
  it("reports liveness", async () => {
    const res = await appWith("ok").request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "test" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const res = await appWith("degraded").request("/readyz");
    expect(res.status).toBe(503);
  });
});

// MCP checks the Host header, which fetch() won't let us set, so these tests use a real server.
describe("mcp", () => {
  let server: ServerType;
  let port: number;

  beforeAll(async () => {
    server = serve({ fetch: appWith("ok").fetch, port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    port = address.port;
  });
  afterAll(() => void server.close());

  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });

  const post = (host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            host,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(initialize);
    });

  it("completes the initialize handshake", async () => {
    const res = await post("orrery.test");
    expect(res.status).toBe(200);
    expect(res.body).toContain('"serverInfo"');
  });

  it("rejects a Host header that isn't PUBLIC_URL's host", async () => {
    const res = await post("evil.example");
    expect(res.status).toBe(403);
  });
});
