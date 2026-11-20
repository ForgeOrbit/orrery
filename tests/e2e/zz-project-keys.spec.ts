// #95 black-box proof: project keys and KEY-N issue identifiers over REST and MCP against
// a running Orrery. The same payloads are read through an agent key over the MCP protocol,
// so a shared contract change cannot be visible on only one transport.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
});

async function personalWorkspaceOf(): Promise<string> {
  const res = await api.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list = asArray(await res.json());
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function createProject(key: string): Promise<{ id: string; workspaceId: string }> {
  const workspaceId = await personalWorkspaceOf();
  const res = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Keyed ${key}`, key },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body).toMatchObject({ key, workspaceId, name: `Keyed ${key}` });
  return { id: idOf(body, "project"), workspaceId };
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: "orrery-e2e-keys", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: asRecord(result.structuredContent) };
}

test("REST exposes workspace-unique keys and immutable key updates", async () => {
  const workspaceId = await personalWorkspaceOf();
  const project = await createProject("KEYS");

  const duplicate = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Duplicate key", key: "KEYS" },
  });
  expect(duplicate.status()).toBe(409);
  expect(duplicate.headers()["content-type"]).toBe("application/problem+json");
  expect(await duplicate.json()).toMatchObject({ code: "project_key_taken", status: 409 });

  const invalid = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Invalid key", key: "keys" },
  });
  expect(invalid.status()).toBe(400);

  const renamed = await api.patch(`/api/projects/${project.id}`, {
    data: { name: "Renamed keyed project", key: "NEXT" },
  });
  expect(renamed.status()).toBe(409);
  expect(await renamed.json()).toMatchObject({ code: "project_key_immutable", status: 409 });

  const fetched = await api.get(`/api/projects/${project.id}`);
  expect(fetched.status()).toBe(200);
  expect(await fetched.json()).toMatchObject({ key: "KEYS", name: `Keyed KEYS` });

  // A caller that omits the key still gets a valid derived one.
  const derived = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Derived Key" },
  });
  expect(derived.status()).toBe(201);
  expect(await derived.json()).toMatchObject({
    key: expect.stringMatching(/^[A-Z][A-Z0-9]{1,9}$/),
  });
});

test("REST resolves a transfer key collision with a replacement key only", async () => {
  const moved = await createProject("TRNS");
  const destRes = await api.post("/api/workspaces", {
    data: { name: `Transfer destination ${randomUUID()}` },
  });
  expect(destRes.status()).toBe(201);
  const destinationId = idOf(await destRes.json(), "destination workspace");
  const occupant = await api.post(`/api/workspaces/${destinationId}/projects`, {
    data: { name: "Destination occupant", key: "TRNS" },
  });
  expect(occupant.status()).toBe(201);

  const collided = await api.post(`/api/projects/${moved.id}/transfer/complete`, {
    data: { destinationWorkspaceId: destinationId },
  });
  expect(collided.status()).toBe(409);
  expect(await collided.json()).toMatchObject({ code: "project_key_conflict", status: 409 });
  const unchanged = await api.get(`/api/projects/${moved.id}`);
  expect(await unchanged.json()).toMatchObject({ key: "TRNS" });

  // A key is only renameable here to resolve a collision, never as a general edit path.
  const other = await createProject("NOCO");
  const secondDest = await api.post("/api/workspaces", {
    data: { name: `Other destination ${randomUUID()}` },
  });
  expect(secondDest.status()).toBe(201);
  const otherDestinationId = idOf(await secondDest.json(), "other workspace");
  const rename = await api.post(`/api/projects/${other.id}/transfer/complete`, {
    data: { destinationWorkspaceId: otherDestinationId, key: "CHNG" },
  });
  expect(rename.status()).toBe(409);
  expect(await rename.json()).toMatchObject({ code: "project_key_immutable", status: 409 });

  const resolved = await api.post(`/api/projects/${moved.id}/transfer/complete`, {
    data: { destinationWorkspaceId: destinationId, key: "TRN2" },
  });
  expect(resolved.status()).toBe(200);
  expect(await resolved.json()).toMatchObject({
    id: moved.id,
    workspaceId: destinationId,
    key: "TRN2",
  });

  const issue = await api.post(`/api/projects/${moved.id}/issues`, {
    data: { title: "Issue after the key rename" },
  });
  expect(issue.status()).toBe(201);
  expect(await issue.json()).toMatchObject({ identifier: "TRN2-1" });
});

test("REST and MCP carry the KEY-N identifier on issue payloads", async () => {
  const project = await createProject("MCPK");
  const created = await api.post(`/api/projects/${project.id}/issues`, {
    data: { title: "MCP identifier issue" },
  });
  expect(created.status()).toBe(201);
  const issue = await created.json();
  expect(issue).toMatchObject({ number: 1, identifier: "MCPK-1" });

  const listed = await api.get(`/api/projects/${project.id}/issues`);
  expect(listed.status()).toBe(200);
  expect(asArray(await listed.json())).toContainEqual(
    expect.objectContaining({ id: idOf(issue, "issue"), identifier: "MCPK-1" }),
  );

  const agentName = `key-agent-${randomUUID()}`;
  const agentRes = await api.post("/api/agents", { data: { name: agentName } });
  expect(agentRes.status()).toBe(201);
  const agentId = idOf(await agentRes.json(), "agent");
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId: project.workspaceId,
      validity: "90",
      projects: [{ projectId: project.id, level: "read" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const secret = requiredText(field(await keyRes.json(), "secret"), "the agent key secret");
  await recordSecret(secret);

  const client = await connect(secret);
  try {
    const projectResult = await call(client, "get_project", { projectId: project.id });
    expect(projectResult.isError).toBe(false);
    expect(asRecord(projectResult.data.project)).toMatchObject({ key: "MCPK" });

    const issueResult = await call(client, "get_issue", { issueId: idOf(issue, "issue") });
    expect(issueResult.isError).toBe(false);
    expect(asRecord(issueResult.data.issue)).toMatchObject({ identifier: "MCPK-1" });

    const listResult = await call(client, "list_issues", { projectId: project.id });
    expect(listResult.isError).toBe(false);
    expect(asArray(listResult.data.issues)).toContainEqual(
      expect.objectContaining({ identifier: "MCPK-1" }),
    );
  } finally {
    await client.close();
  }
});
