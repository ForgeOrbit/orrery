// Fallback policy and late answers (issue #42), black-box against a running Orrery through
// a real MCP protocol client plus REST. A human Manage sets the project policy; an agent
// asks, checks in at the one-hour boundary and reads its authorized fallback back. With
// `require_human` the same boundary pauses the question, releases the claim and keeps the
// issue out of ready work until a human answers. A late answer is stored as a follow-up.
// No server code is imported; the deadline is a test fixture set inside Postgres.
//
// `docker compose` here follows the same COMPOSE_PROJECT_NAME the stack was started with
// (or the default project), so this spec also runs in CI's standard `pnpm test:e2e`.
// An isolated local run can set COMPOSE_PROJECT_NAME and custom ports via --env-file.
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const run = promisify(exec);
const configuredBaseUrl = process.env.ORRERY_URL;
if (!configuredBaseUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl = configuredBaseUrl;
const composeFile =
  process.env.ORRERY_COMPOSE_FILE ?? new URL("../../compose.yaml", import.meta.url).pathname;
const postgresService = process.env.ORRERY_COMPOSE_POSTGRES ?? "postgres";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list = asArray(await res.json());
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return requiredText(field(personal, "id"), "the personal workspace id");
}

async function newProject(client: APIRequestContext): Promise<string> {
  const workspaceId = await personalWorkspaceOf(client);
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Fallback e2e ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the project id");
}

async function newIssue(client: APIRequestContext, projectId: string): Promise<string> {
  const res = await client.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Waiting on a human" },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the issue id");
}

async function createAgent(client: APIRequestContext): Promise<string> {
  const res = await client.post("/api/agents", { data: { name: `fallback-bot-${randomUUID()}` } });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the agent id");
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

type CallResult = { isError: boolean; data: Record<string, unknown> };

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: `orrery-fallback-e2e-${randomUUID()}`, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: asRecord(result.structuredContent) };
}

async function newRun(client: Client): Promise<string> {
  const result = await call(client, "orrery_run_checkin", {
    event: "run_started",
    runKey: { harness: "e2e", nativeSessionId: randomUUID() },
  });
  expect(result.isError).toBe(false);
  return requiredText(field(result.data, "runId"), "the run id");
}

// Move the one-hour response deadline into database time without a real one-hour wait.
async function expireQuestion(questionId: string): Promise<void> {
  const sql =
    `UPDATE questions SET response_deadline_at = statement_timestamp() - interval '1 second', ` +
    `created_at = statement_timestamp() - interval '2 hours' WHERE id = '${questionId}'`;
  await run(
    `docker compose -f "${composeFile}" exec -T ${postgresService} ` +
      `psql -U orrery -d orrery -c "${sql}"`,
    { timeout: 60_000 },
  );
}

async function questionOf(client: Client, issueId: string, questionId: string) {
  const result = await call(client, "list_issue_questions", { issueId });
  expect(result.isError).toBe(false);
  const questions = asArray(field(result.data, "questions"));
  const found = questions.find((item) => field(item, "id") === questionId);
  return asRecord(found);
}

let api: APIRequestContext;
let agentApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  agentApi = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await api?.dispose();
  await agentApi?.dispose();
});

test("fallback_allowed authorizes the fallback and keeps a checking-in claim", async () => {
  const projectId = await newProject(api);
  const issueId = await newIssue(api, projectId);
  const workspaceId = await personalWorkspaceOf(api);
  const agentId = await createAgent(api);
  const secret = await issueKey(api, agentId, workspaceId, projectId);

  // Human Manage sets the policy; an agent key is refused on the very same route.
  const allowed = await api.patch(`/api/projects/${projectId}/fallback-policy`, {
    data: { fallbackPolicy: "fallback_allowed" },
  });
  expect(allowed.status()).toBe(200);
  expect(field(await allowed.json(), "fallbackPolicy")).toBe("fallback_allowed");
  const agentPolicy = await agentApi.patch(`/api/projects/${projectId}/fallback-policy`, {
    headers: { Authorization: `Bearer ${secret}` },
    data: { fallbackPolicy: "fallback_allowed" },
  });
  expect(agentPolicy.status()).toBe(401);
  expect(agentPolicy.headers()["content-type"]).toContain("application/problem+json");

  const client = await connect(secret);
  try {
    // No MCP tool exists for policy: an agent cannot authorize its own fallback.
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).some((name) => name.includes("policy"))).toBe(
      false,
    );

    const runId = await newRun(client);
    const claimed = await call(client, "claim_issue", { issueId, runId });
    expect(claimed.isError).toBe(false);
    const questionText = `Proceed with which endpoint? ${randomUUID()}`;
    const asked = await call(client, "ask_for_input", {
      issueId,
      runId,
      question: questionText,
      proposedFallback: "Use the v1 endpoint",
    });
    expect(asked.isError).toBe(false);
    const questionId = requiredText(
      field(asRecord(field(asked.data, "question")), "id"),
      "the question id",
    );
    expect(field(asRecord(field(asked.data, "question")), "authorizedFallback")).toBeNull();

    await expireQuestion(questionId);
    // Checking in at the boundary resolves the fallback and keeps this worker's claim.
    const renewed = await call(client, "renew_claim", { issueId });
    expect(renewed.isError).toBe(false);

    const resolved = await questionOf(client, issueId, questionId);
    expect(field(resolved, "status")).toBe("fallback_used");
    expect(field(resolved, "authorizedFallback")).toBe("Use the v1 endpoint");

    // REST sees the same authorization, and a late human answer is a follow-up only.
    const restHistory = await api.get(`/api/issues/${issueId}/questions`);
    expect(restHistory.status()).toBe(200);
    const restQuestion = asArray(await restHistory.json()).find(
      (item) => field(item, "id") === questionId,
    );
    expect(field(restQuestion, "status")).toBe("fallback_used");
    expect(field(restQuestion, "authorizedFallback")).toBe("Use the v1 endpoint");

    const late = await api.post(`/api/questions/${questionId}/answer`, {
      data: { answer: "Prefer v2 after the release" },
    });
    expect(late.status()).toBe(200);
    expect(field(await late.json(), "followUp")).toBe("Prefer v2 after the release");
    const afterLate = await questionOf(client, issueId, questionId);
    expect(field(afterLate, "status")).toBe("fallback_used");
    expect(field(afterLate, "answer")).toBeNull();

    // With no live claim, Needs input is clear so the issue is ready work again.
    const stopped = await call(client, "stop_session", { issueId, outcome: "completed" });
    expect(stopped.isError).toBe(false);
    const ready = await call(client, "ready_work", { projectId });
    expect(ready.isError).toBe(false);
    expect(asArray(field(ready.data, "issues")).some((item) => field(item, "id") === issueId)).toBe(
      true,
    );
  } finally {
    await client.close();
  }
});

test("require_human pauses at the deadline and keeps Needs input until a human answers", async () => {
  const projectId = await newProject(api);
  const issueId = await newIssue(api, projectId);
  const workspaceId = await personalWorkspaceOf(api);
  const agentId = await createAgent(api);
  const secret = await issueKey(api, agentId, workspaceId, projectId);

  const client = await connect(secret);
  try {
    const runId = await newRun(client);
    expect((await call(client, "claim_issue", { issueId, runId })).isError).toBe(false);
    const asked = await call(client, "ask_for_input", {
      issueId,
      runId,
      question: "Which database should we use?",
      proposedFallback: "Use Postgres",
    });
    expect(asked.isError).toBe(false);
    const questionId = requiredText(
      field(asRecord(field(asked.data, "question")), "id"),
      "the question id",
    );

    await expireQuestion(questionId);
    // The claim was released at the deadline: there is nothing left to renew.
    const renewed = await call(client, "renew_claim", { issueId });
    expect(renewed.isError).toBe(true);
    expect(field(renewed.data, "code")).toBe("session_required");

    const paused = await questionOf(client, issueId, questionId);
    expect(field(paused, "status")).toBe("paused");
    expect(field(paused, "authorizedFallback")).toBeNull();
    const restHistory = await api.get(`/api/issues/${issueId}/questions`);
    expect(
      field(
        asArray(await restHistory.json()).find((item) => field(item, "id") === questionId),
        "status",
      ),
    ).toBe("paused");
    // Needs input is still set: the paused issue is not offered as ready work.
    const beforeAnswer = await call(client, "ready_work", { projectId });
    expect(beforeAnswer.isError).toBe(false);
    expect(
      asArray(field(beforeAnswer.data, "issues")).some((item) => field(item, "id") === issueId),
    ).toBe(false);

    // A human answer unblocks the issue; no fallback is ever authorized here.
    const answered = await api.post(`/api/questions/${questionId}/answer`, {
      data: { answer: "Use Postgres 18" },
    });
    expect(answered.status()).toBe(200);
    expect(field(await answered.json(), "status")).toBe("answered");
    const ready = await call(client, "ready_work", { projectId });
    expect(asArray(field(ready.data, "issues")).some((item) => field(item, "id") === issueId)).toBe(
      true,
    );
  } finally {
    await client.close();
  }
});

test("an agent cannot set an issue override and invalid policy bodies are Problems", async () => {
  const projectId = await newProject(api);
  const issueId = await newIssue(api, projectId);
  const workspaceId = await personalWorkspaceOf(api);
  const agentId = await createAgent(api);
  const secret = await issueKey(api, agentId, workspaceId, projectId);

  const agentOverride = await agentApi.patch(`/api/issues/${issueId}/fallback-policy`, {
    headers: { Authorization: `Bearer ${secret}` },
    data: { override: "fallback_allowed" },
  });
  expect(agentOverride.status()).toBe(401);
  expect(agentOverride.headers()["content-type"]).toContain("application/problem+json");

  const invalid = await api.patch(`/api/projects/${projectId}/fallback-policy`, {
    data: { fallbackPolicy: "no_such_policy" },
  });
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()["content-type"]).toContain("application/problem+json");
});
