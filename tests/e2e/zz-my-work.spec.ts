// Cross-workspace My work (issue #99), black-box against a running Orrery. A signed-in
// human sees their personal and shared assignments, the live sessions under their own
// agents and the questions waiting on them; agent keys and anonymous callers get a 401
// Problem. Nothing here imports server code.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const hasId = (items: readonly unknown[], id: string): boolean =>
  items.some((item) => field(item, "id") === id || field(item, "sessionId") === id);

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const list = await client.get("/api/workspaces");
  expect(list.status()).toBe(200);
  const workspaces: unknown = await list.json();
  const personal = asArray(workspaces).find((w) => field(w, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function createProject(client: APIRequestContext, workspaceId: string, label: string) {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `${label} ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  return {
    id: idOf(body, "project"),
    key: requiredText(field(body, "key"), "the project key"),
  };
}

async function createIssue(
  client: APIRequestContext,
  projectId: string,
  title: string,
  assigneeHumanId?: string,
) {
  const created = await client.post(`/api/projects/${projectId}/issues`, { data: { title } });
  expect(created.status()).toBe(201);
  const body: unknown = await created.json();
  const issue = {
    id: idOf(body, "issue"),
    identifier: requiredText(field(body, "identifier"), "the issue identifier"),
  };
  if (assigneeHumanId !== undefined) {
    const assigned = await client.patch(`/api/issues/${issue.id}`, {
      data: { assignee: { type: "human", id: assigneeHumanId } },
    });
    expect(assigned.status()).toBe(200);
  }
  return issue;
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name: `${name}-${randomUUID()}` } });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "agent");
}

async function issueKey(
  client: APIRequestContext,
  agentId: string,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  const res = await client.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(res.status()).toBe(201);
  const secret = requiredText(field(await res.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

async function newRun(client: APIRequestContext, secret: string): Promise<string> {
  const res = await client.post("/api/runs/hook", {
    headers: { Authorization: `Bearer ${secret}` },
    data: {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "my-work-e2e", nativeSessionId: randomUUID() },
    },
  });
  expect(res.status()).toBe(200);
  return requiredText(field(await res.json(), "runId"), "the run id");
}

let api: APIRequestContext;
let agentApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  // A separate context has no human cookie, so a bearer key cannot be helped by a session.
  agentApi = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await api?.dispose();
  await agentApi?.dispose();
});

test("aggregates personal and shared work, filters terminal and trashed issues, and refuses agent keys", async () => {
  const personalWorkspaceId = await personalWorkspaceOf(api);
  const personalProject = await createProject(api, personalWorkspaceId, "My work personal");
  const shared = await api.post("/api/workspaces", {
    data: { name: `My work shared ${randomUUID()}` },
  });
  expect(shared.status()).toBe(201);
  const sharedWorkspaceId = idOf(await shared.json(), "shared workspace");
  const sharedProject = await createProject(api, sharedWorkspaceId, "My work shared");

  const projectView = await api.get(`/api/projects/${personalProject.id}`);
  expect(projectView.status()).toBe(200);
  const humanId = requiredText(
    field(field(await projectView.json(), "createdBy"), "humanId"),
    "the signed-in human id",
  );

  const personalIssue = await createIssue(api, personalProject.id, "Personal assignment", humanId);
  const sharedIssue = await createIssue(api, sharedProject.id, "Shared assignment", humanId);
  const doneIssue = await createIssue(api, personalProject.id, "Finished assignment", humanId);
  expect(
    (await api.patch(`/api/issues/${doneIssue.id}`, { data: { status: "done" } })).status(),
  ).toBe(200);
  const trashedIssue = await createIssue(api, personalProject.id, "Trashed assignment", humanId);
  expect((await api.delete(`/api/issues/${trashedIssue.id}`)).status()).toBe(204);

  const agentId = await createAgent(api, "my-work-agent");
  const personalKey = await issueKey(api, agentId, personalWorkspaceId, personalProject.id);
  const sessionIssue = await createIssue(api, personalProject.id, "Agent is working here");
  const runId = await newRun(agentApi, personalKey);
  const claim = await agentApi.post(`/api/issues/${sessionIssue.id}/work-sessions`, {
    headers: { Authorization: `Bearer ${personalKey}` },
    data: { runId },
  });
  expect(claim.status()).toBe(201);
  const sessionId = idOf(await claim.json(), "work session");

  const sharedKey = await issueKey(api, agentId, sharedWorkspaceId, sharedProject.id);
  const questionIssue = await createIssue(api, sharedProject.id, "Needs a human decision");
  const questionRunId = await newRun(agentApi, sharedKey);
  expect(
    (
      await agentApi.post(`/api/issues/${questionIssue.id}/work-sessions`, {
        headers: { Authorization: `Bearer ${sharedKey}` },
        data: { runId: questionRunId },
      })
    ).status(),
  ).toBe(201);
  const asked = await agentApi.post("/api/questions", {
    headers: { Authorization: `Bearer ${sharedKey}` },
    data: {
      issueId: questionIssue.id,
      runId: questionRunId,
      question: `Which option for ${randomUUID()}?`,
      proposedFallback: "Use the safe default",
    },
  });
  expect(asked.status()).toBe(201);
  const questionId = idOf(await asked.json(), "question");

  const response = await api.get("/api/my-work");
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const assigned = asArray(field(body, "assignedIssues"));
  expect(hasId(assigned, personalIssue.id)).toBe(true);
  expect(hasId(assigned, sharedIssue.id)).toBe(true);
  expect(hasId(assigned, doneIssue.id)).toBe(false);
  expect(hasId(assigned, trashedIssue.id)).toBe(false);
  const personalItem = assigned.find((item) => field(item, "id") === personalIssue.id);
  expect(personalItem).toMatchObject({
    identifier: personalIssue.identifier,
    projectKey: personalProject.key,
    workspaceId: personalWorkspaceId,
  });
  const sharedItem = assigned.find((item) => field(item, "id") === sharedIssue.id);
  expect(sharedItem).toMatchObject({
    identifier: sharedIssue.identifier,
    projectKey: sharedProject.key,
    workspaceId: sharedWorkspaceId,
  });

  const sessions = asArray(field(body, "activeAgentSessions"));
  expect(hasId(sessions, sessionId)).toBe(true);
  expect(sessions.find((s) => field(s, "sessionId") === sessionId)).toMatchObject({
    agentId,
    issueIdentifier: sessionIssue.identifier,
    harness: "my-work-e2e",
  });

  const questions = asArray(field(body, "needsInputQuestions"));
  expect(hasId(questions, questionId)).toBe(true);
  expect(questions.find((q) => field(q, "id") === questionId)).toMatchObject({
    issueIdentifier: questionIssue.identifier,
    workspaceId: sharedWorkspaceId,
    status: "open",
  });

  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const denied = await anonymous.get("/api/my-work");
    expect(denied.status()).toBe(401);
    expect(denied.headers()["content-type"]).toContain("application/problem+json");
    expect(field(await denied.json(), "code")).toBe("not_signed_in");
  } finally {
    await anonymous.dispose();
  }

  const withKey = await agentApi.get("/api/my-work", {
    headers: { Authorization: `Bearer ${personalKey}` },
  });
  expect(withKey.status()).toBe(401);
  expect(withKey.headers()["content-type"]).toContain("application/problem+json");
  expect(field(await withKey.json(), "code")).toBe("not_signed_in");
});
