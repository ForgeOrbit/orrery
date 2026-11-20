// #97 black-box proof: project-scoped labels and one-level subtasks over REST and MCP
// against a running Orrery. The same payload shapes are asserted on both transports.
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

async function personalWorkspaceId(): Promise<string> {
  const res = await api.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const personal = asArray(await res.json()).find((w) => field(w, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function createProject(key: string): Promise<{ id: string; workspaceId: string }> {
  const workspaceId = await personalWorkspaceId();
  const res = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Labels ${key}`, key },
  });
  expect(res.status()).toBe(201);
  return { id: idOf(await res.json(), "project"), workspaceId };
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: "orrery-e2e-labels", version: "0" });
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

async function newRun(client: Client): Promise<string> {
  const result = await call(client, "orrery_run_checkin", {
    event: "run_started",
    runKey: { harness: "codex", nativeSessionId: randomUUID() },
  });
  expect(result.isError).toBe(false);
  return requiredText(field(result.data, "runId"), "the run id");
}

test("REST manages labels, one-level subtasks, and the ready queue", async () => {
  const project = await createProject("LBLS");
  const sibling = await createProject("LBLS2");

  const bug = await api.post(`/api/projects/${project.id}/labels`, {
    data: { name: "Bug", color: "#ff0000" },
  });
  expect(bug.status()).toBe(201);
  const labelId = idOf(await bug.json(), "label");

  const duplicate = await api.post(`/api/projects/${project.id}/labels`, {
    data: { name: "bug", color: "#00ff00" },
  });
  expect(duplicate.status()).toBe(409);
  expect(duplicate.headers()["content-type"]).toBe("application/problem+json");
  expect(await duplicate.json()).toMatchObject({ code: "label_exists", status: 409 });

  const renamed = await api.patch(`/api/labels/${labelId}`, { data: { name: "Defect" } });
  expect(renamed.status()).toBe(200);
  expect(await renamed.json()).toMatchObject({ name: "Defect", color: "#ff0000" });

  const parent = await api.post(`/api/projects/${project.id}/issues`, {
    data: { title: "Parent" },
  });
  expect(parent.status()).toBe(201);
  const parentId = idOf(await parent.json(), "parent");

  const subtask = await api.post(`/api/projects/${project.id}/issues`, {
    data: { title: "Subtask", parentIssueId: parentId },
  });
  expect(subtask.status()).toBe(201);
  expect(await subtask.json()).toMatchObject({ parentIssueId: parentId, labels: [] });
  const subtaskId = idOf(await subtask.json(), "subtask");

  const attached = await api.post(`/api/issues/${subtaskId}/labels/${labelId}`);
  expect(attached.status()).toBe(201);
  expect(await attached.json()).toMatchObject({
    parentIssueId: parentId,
    labels: [{ id: labelId, name: "Defect", color: "#ff0000" }],
  });

  const fetched = await api.get(`/api/issues/${subtaskId}`);
  expect((await fetched.json()).labels).toMatchObject([{ id: labelId }]);

  const ready = await api.get(`/api/projects/${project.id}/ready-work`);
  expect(ready.status()).toBe(200);
  expect(asArray(await ready.json()).map((issue) => field(issue, "id"))).toEqual(
    expect.arrayContaining([parentId, subtaskId]),
  );

  // Error kinds for every new rule map to their real status, never a 500.
  const selfParent = await api.patch(`/api/issues/${subtaskId}`, {
    data: { parentIssueId: subtaskId },
  });
  expect(selfParent.status()).toBe(400);
  expect(await selfParent.json()).toMatchObject({ code: "self_parent", status: 400 });

  const otherIssue = await api.post(`/api/projects/${sibling.id}/issues`, {
    data: { title: "Elsewhere" },
  });
  const crossProject = await api.patch(`/api/issues/${subtaskId}`, {
    data: { parentIssueId: idOf(await otherIssue.json(), "issue") },
  });
  expect(crossProject.status()).toBe(400);
  expect(await crossProject.json()).toMatchObject({ code: "cross_project_parent", status: 400 });

  const tooDeep = await api.patch(`/api/issues/${parentId}`, {
    data: { parentIssueId: subtaskId },
  });
  expect(tooDeep.status()).toBe(409);
  expect(await tooDeep.json()).toMatchObject({ code: "subtask_depth_exceeded", status: 409 });

  const foreignLabel = await api.post(`/api/projects/${sibling.id}/labels`, {
    data: { name: "Foreign", color: "#abcdef" },
  });
  const notFound = await api.post(
    `/api/issues/${parentId}/labels/${idOf(await foreignLabel.json(), "label")}`,
  );
  expect(notFound.status()).toBe(404);
  expect(await notFound.json()).toMatchObject({ code: "label_not_found", status: 404 });

  const detached = await api.delete(`/api/issues/${subtaskId}/labels/${labelId}`);
  expect(detached.status()).toBe(200);
  expect((await detached.json()).labels).toEqual([]);

  const deleted = await api.delete(`/api/labels/${labelId}`);
  expect(deleted.status()).toBe(204);
});

test("MCP manages labels and one-level subtasks with the same shapes", async () => {
  const project = await createProject("LBMM");
  const agentName = `labels-agent-${randomUUID()}`;
  const agentRes = await api.post("/api/agents", { data: { name: agentName } });
  expect(agentRes.status()).toBe(201);
  const agentId = idOf(await agentRes.json(), "agent");
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId: project.workspaceId,
      validity: "90",
      projects: [{ projectId: project.id, level: "contribute" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const secret = requiredText(field(await keyRes.json(), "secret"), "the agent key secret");
  await recordSecret(secret);

  const client = await connect(secret);
  try {
    const created = await call(client, "create_label", {
      projectId: project.id,
      name: "Agent label",
      color: "#00ff00",
    });
    expect(created.isError).toBe(false);
    const labelId = idOf(created.data.label, "label");

    const listed = await call(client, "list_labels", { projectId: project.id });
    expect(listed.isError).toBe(false);
    expect(asArray(listed.data.labels)).toContainEqual(
      expect.objectContaining({ id: labelId, name: "Agent label" }),
    );

    const parent = await call(client, "create_issue", {
      projectId: project.id,
      title: "MCP parent",
    });
    expect(parent.isError).toBe(false);
    const parentId = idOf(parent.data.issue, "parent");
    const subtask = await call(client, "create_issue", {
      projectId: project.id,
      title: "MCP subtask",
      parentIssueId: parentId,
    });
    expect(subtask.isError).toBe(false);
    expect(asRecord(subtask.data.issue)).toMatchObject({ parentIssueId: parentId });
    const subtaskId = idOf(subtask.data.issue, "subtask");

    const attached = await call(client, "attach_issue_label", { issueId: subtaskId, labelId });
    expect(attached.isError).toBe(false);
    expect(asRecord(attached.data.issue).labels).toMatchObject([{ id: labelId }]);

    const ready = await call(client, "ready_work", { projectId: project.id });
    expect(ready.isError).toBe(false);
    expect(asArray(ready.data.issues).map((issue) => field(issue, "id"))).toEqual(
      expect.arrayContaining([parentId, subtaskId]),
    );

    // The subtask is independently claimable end-to-end: no session on the parent is
    // needed, and the claim is a real active work session on the subtask itself.
    const claim = await call(client, "claim_issue", {
      issueId: subtaskId,
      runId: await newRun(client),
    });
    expect(claim.isError).toBe(false);
    expect(asRecord(claim.data.session)).toMatchObject({ issueId: subtaskId, status: "active" });

    const tooDeep = await call(client, "update_issue", {
      issueId: parentId,
      parentIssueId: subtaskId,
    });
    expect(tooDeep.isError).toBe(true);
    expect(tooDeep.data).toMatchObject({ code: "subtask_depth_exceeded" });

    const detached = await call(client, "detach_issue_label", { issueId: subtaskId, labelId });
    expect(detached.isError).toBe(false);
    expect(asRecord(detached.data.issue).labels).toEqual([]);

    const updated = await call(client, "update_label", { labelId, name: "Renamed label" });
    expect(updated.isError).toBe(false);
    expect(asRecord(updated.data.label)).toMatchObject({ name: "Renamed label" });

    const removed = await call(client, "delete_label", { labelId });
    expect(removed.isError).toBe(false);
    expect(removed.data).toMatchObject({ removed: true });
  } finally {
    await client.close();
  }
});
