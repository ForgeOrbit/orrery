import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

describe("health", () => {
  it.each(["/healthz", "/readyz"])("%s reports ok", async (path) => {
    const res = await fetch(new URL(path, baseUrl));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});

describe("web app", () => {
  it("serves index.html for client-side routes", async () => {
    const res = await fetch(new URL("/some/client/route", baseUrl));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});

describe("mcp", () => {
  it("completes the MCP handshake", async () => {
    const client = new Client({ name: "orrery-e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", baseUrl)));
    expect(client.getServerVersion()?.name).toBe("orrery");
    await client.close();
  });
});
