// Human input through the inbox (issue #41), black-box against a running Orrery:
// an agent with a live claim asks via REST, the owner is notified through Mailpit, an
// agent key (including a sibling run) cannot answer, and a human answers both through
// REST and through the web inbox. Nothing here imports server code.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

function idOf(value: unknown, what: string): string {
  return requiredText(field(value, "id"), `the ${what} id`);
}

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function login(client: APIRequestContext, email: string, password: string) {
  const res = await client.post("/api/auth/login", { data: { email, password } });
  expect(res.status()).toBe(200);
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name } });
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
  const body: unknown = await res.json();
  const secret = requiredText(field(body, "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

// A fresh API context keeps the bearer key from being helped by a human cookie jar.
let api: APIRequestContext;
let agentApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  await login(api, ADMIN_EMAIL, ADMIN_PASSWORD);
  agentApi = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await api?.dispose();
  await agentApi?.dispose();
});

async function caughtQuestionEmail(client: APIRequestContext, questionText: string) {
  await expect
    .poll(
      async () => {
        const list = await client.get(`${mailpit}/api/v1/messages`);
        const body: unknown = await list.json();
        const messages: unknown =
          typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
        if (!Array.isArray(messages)) return false;
        for (const message of messages) {
          if (field(message, "Subject") !== `Orrery: input needed on #1 Blocked by e2e`) continue;
          const id = field(message, "ID");
          if (typeof id !== "string") continue;
          const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
          const caught: unknown = await detail.json();
          const text = field(caught, "Text");
          const to = field(caught, "To");
          const addresses = Array.isArray(to)
            ? to.flatMap((entry) => {
                const address = field(entry, "Address");
                return typeof address === "string" ? [address] : [];
              })
            : [];
          if (
            typeof text === "string" &&
            text.includes(questionText) &&
            addresses.includes(ADMIN_EMAIL)
          )
            return true;
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

// One claimable issue, run and agent key, with an open question already asked.
async function askForInput() {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Inbox e2e ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const issueRes = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Blocked by e2e" },
  });
  expect(issueRes.status()).toBe(201);
  const issueId = idOf(await issueRes.json(), "issue");

  const agentId = await createAgent(api, `inbox-bot-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const runRes = await agentApi.post("/api/runs/hook", {
    headers: { Authorization: `Bearer ${secret}` },
    data: {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "e2e", nativeSessionId: randomUUID() },
    },
  });
  expect(runRes.status()).toBe(200);
  const runId = requiredText(field(await runRes.json(), "runId"), "run id");

  const claim = await agentApi.post(`/api/issues/${issueId}/work-sessions`, {
    headers: { Authorization: `Bearer ${secret}` },
    data: { runId },
  });
  expect(claim.status()).toBe(201);

  const questionText = `Which API should we use for ${randomUUID()}?`;
  const ask = await agentApi.post("/api/questions", {
    headers: { Authorization: `Bearer ${secret}` },
    data: {
      issueId,
      runId,
      question: questionText,
      proposedFallback: "Use the v1 endpoint",
    },
  });
  expect(ask.status()).toBe(201);
  const questionId = idOf(await ask.json(), "question");
  return { issueId, questionId, questionText, secret };
}

test("emails the agent owner, refuses agent answerers and lets a human answer", async ({
  browser,
}) => {
  const { issueId, questionId, questionText, secret } = await askForInput();

  await caughtQuestionEmail(api, questionText);

  // An agent key — including one for a sibling run of the same agent — cannot answer.
  const denied = await agentApi.post(`/api/questions/${questionId}/answer`, {
    headers: { Authorization: `Bearer ${secret}` },
    data: { answer: "agent answer" },
  });
  expect(denied.status()).toBe(403);
  expect(denied.headers()["content-type"]).toContain("application/problem+json");
  expect((await denied.json()).code).toBe("agents_cannot_answer");

  const inboxRes = await api.get("/api/inbox");
  expect(inboxRes.status()).toBe(200);
  const inbox: unknown = await inboxRes.json();
  if (!Array.isArray(inbox)) throw new Error("the inbox is not a list");
  expect(inbox.some((item) => field(item, "id") === questionId)).toBe(true);

  // A human answers through the web inbox after signing in.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
    await page.goto("/inbox");
    const card = page.locator(`li[data-question-id="${questionId}"]`);
    await expect(card).toContainText(questionText);
    await card.getByRole("textbox", { name: "Answer" }).fill("Use the v2 endpoint");
    await card.getByRole("button", { name: "Answer question" }).click();
    await expect(card.locator("[data-question-status]")).toHaveText(/answered/);
    await expect(card.locator("[data-question-answer]")).toContainText("Use the v2 endpoint");
  } finally {
    for (const cookie of await context.cookies()) await recordSecret(cookie.value);
    await context.close();
  }

  // The agent reads the human's answer back over MCP; there is still no answer tool for
  // an agent key.
  const mcp = new Client({ name: `orrery-inbox-e2e-${randomUUID()}`, version: "1" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  try {
    const result = await mcp.callTool({
      name: "list_issue_questions",
      arguments: { issueId },
    });
    expect(result.isError).not.toBe(true);
    const listed = field(result.structuredContent, "questions");
    if (!Array.isArray(listed)) throw new Error("MCP question history is not a list");
    expect(
      listed.some(
        (item) =>
          field(item, "id") === questionId && field(item, "answer") === "Use the v2 endpoint",
      ),
    ).toBe(true);
  } finally {
    await mcp.close();
  }

  const historyRes = await api.get(`/api/issues/${issueId}/questions`);
  expect(historyRes.status()).toBe(200);
  const history: unknown = await historyRes.json();
  if (!Array.isArray(history)) throw new Error("question history is not a list");
  const stored = history.find((item) => field(item, "id") === questionId);
  expect(field(stored, "status")).toBe("answered");
  expect(field(stored, "answer")).toBe("Use the v2 endpoint");
});
