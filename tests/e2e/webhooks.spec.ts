import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

// The stack must be started with ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=true so the server will
// deliver to the receiver this spec hosts on the machine running Playwright (CI sets it).
const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

type Received = {
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  event: string | undefined;
};

let api: APIRequestContext;
let receiver: Server;
let received: Received[];
let webhookId: string | undefined;
let workspaceId: string | undefined;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);

  received = [];
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        signature: header(req.headers["x-orrery-signature-256"]),
        timestamp: header(req.headers["x-orrery-timestamp"]),
        event: header(req.headers["x-orrery-event"]),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "0.0.0.0", resolve));
});

test.afterAll(async () => {
  if (webhookId !== undefined && workspaceId !== undefined) {
    await api.delete(`/api/workspaces/${workspaceId}/webhooks/${webhookId}`);
  }
  if (receiver !== undefined) {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
  await api?.dispose();
});

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringField(value: unknown, key: string): string {
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  if (typeof field !== "string") throw new Error(`missing ${key}`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("delivers a signed metadata-only envelope and never echoes the signing secret", async () => {
  const createdWorkspace = await api.post("/api/workspaces", {
    data: { name: `Webhook E2E ${Date.now()}` },
  });
  expect(createdWorkspace.status()).toBe(201);
  workspaceId = stringField(await createdWorkspace.json(), "id");

  const address = receiver.address();
  if (address === null || typeof address === "string") throw new Error("no receiver address");
  const port = address.port;

  const receiverHost = process.env.ORRERY_WEBHOOK_E2E_HOST ?? "host.docker.internal";
  const created = await api.post(`/api/workspaces/${workspaceId}/webhooks`, {
    data: {
      url: `http://${receiverHost}:${port}/hook`,
      description: "e2e receiver",
      allProjects: true,
      allEvents: true,
    },
  });
  expect(created.status()).toBe(201);
  const hook: unknown = await created.json();
  webhookId = stringField(hook, "id");
  const signingSecret = stringField(hook, "signingSecret");
  expect(signingSecret).toMatch(/^whsec_/);
  // The one-time secret is in the create response only.
  await recordSecret(signingSecret);
  const listed = await api.get(`/api/workspaces/${workspaceId}/webhooks`);
  expect(JSON.stringify(await listed.json())).not.toContain(signingSecret);

  const sent = await api.post(`/api/workspaces/${workspaceId}/webhooks/${webhookId}/test`);
  expect(sent.status()).toBe(201);

  await expect.poll(() => received.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const delivery = received[0]!;
  expect(delivery.event).toBe("webhook.test");
  expect(delivery.timestamp).toBeDefined();
  const expected = createHmac("sha256", signingSecret)
    .update(`${delivery.timestamp}.${delivery.body}`)
    .digest("hex");
  expect(delivery.signature).toBe(`sha256=${expected}`);
  const payload: unknown = JSON.parse(delivery.body);
  if (!isRecord(payload)) throw new Error("the delivery body is not a JSON object");
  expect(payload).toMatchObject({ version: 1, event: "webhook.test" });

  const deliveries = await api.get(
    `/api/workspaces/${workspaceId}/webhooks/${webhookId}/deliveries`,
  );
  expect(deliveries.status()).toBe(200);
  const log = await deliveries.json();
  expect(JSON.stringify(log)).not.toContain(signingSecret);
  expect(JSON.stringify(log)).toContain("webhook.test");
});
