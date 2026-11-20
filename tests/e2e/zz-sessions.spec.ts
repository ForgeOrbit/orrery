// Work sessions and renewable claims (issue #36), black-box against a running Orrery.
// A real MCP protocol client proves fenced agent writes are refused without a live session
// and allowed with one, while reads, creation, comments and knowledge stay unfenced. A
// second client races a claim; a bearer-only REST request checks the same public surface.
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
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const ids = (data: Record<string, unknown>) =>
  asArray(field(data, "issues")).map((item) => field(item, "id"));

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const personal = asArray(await res.json()).find(
    (workspace) => field(workspace, "kind") === "personal",
  );
  return requiredText(field(personal, "id"), "the personal workspace id");
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name } });
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

async function project(client: APIRequestContext, workspaceId: string): Promise<string> {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Session project ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the project id");
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: `orrery-sessions-e2e-${randomUUID()}`, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

type CallResult = { isError: boolean; data: Record<string, unknown> };

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
    runKey: { harness: "codex", nativeSessionId: randomUUID() },
  });
  expect(result.isError).toBe(false);
  return requiredText(field(result.data, "runId"), "the run id");
}

const bearer = (secret: string) => ({
  patch: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  post: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  get: (path: string) =>
    fetch(new URL(path, baseUrl), { headers: { authorization: `Bearer ${secret}` } }),
  del: (path: string) =>
    fetch(new URL(path, baseUrl), {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    }),
});

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

test("fenced writes need a live session; reads, creation, comments and knowledge do not", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-writer-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Fenced issue" });
    expect(created.isError).toBe(false);
    const issue = asRecord(created.data.issue);
    const issueId = requiredText(field(issue, "id"), "the issue id");

    // Unfenced reads and writes work with no claim at all.
    expect((await call(client, "get_issue", { issueId })).isError).toBe(false);
    expect((await call(client, "list_issues", { projectId })).isError).toBe(false);
    expect(
      (await call(client, "create_comment", { issueId, body: "No claim needed" })).isError,
    ).toBe(false);
    const knowledge = await call(client, "create_knowledge", { projectId, title: "Free note" });
    const entryId = requiredText(field(knowledge.data.entry, "id"), "the knowledge id");
    expect((await call(client, "update_knowledge", { entryId, body: "Still free" })).isError).toBe(
      false,
    );
    expect((await call(client, "ready_work", { projectId })).isError).toBe(false);

    // Fenced writes are refused without a session, over both transports, with one code.
    const unfencedMcp = await call(client, "update_issue", { issueId, title: "No session" });
    expect(unfencedMcp.isError).toBe(true);
    expect(unfencedMcp.data).toMatchObject({ code: "session_required" });
    const unfencedRest = await http.patch(`/api/issues/${issueId}`, { title: "No session" });
    expect(unfencedRest.status).toBe(409);
    expect(asRecord(await unfencedRest.json())).toMatchObject({ code: "session_required" });

    // A live session the agent holds allows the edit, close, reopen, progress and stop.
    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    expect(field(claim.data.session, "status")).toBe("active");
    expect((await call(client, "update_issue", { issueId, title: "With a session" })).isError).toBe(
      false,
    );
    expect((await call(client, "update_issue", { issueId, status: "closed" })).isError).toBe(false);
    expect((await call(client, "update_issue", { issueId, status: "open" })).isError).toBe(false);
    expect((await call(client, "renew_claim", { issueId })).isError).toBe(false);
    const progress = await call(client, "report_progress", { issueId, summary: "Halfway" });
    expect(progress.isError).toBe(false);
    expect(field(progress.data.session, "progress")).toBe("Halfway");
    const stopped = await call(client, "stop_session", { issueId, outcome: "completed" });
    expect(stopped.isError).toBe(false);
    expect(field(stopped.data.session, "status")).toBe("completed");

    // Progress survives the stop, and the fenced write is refused again once inactive.
    const readBack = await call(client, "get_work_session", { issueId });
    expect(field(readBack.data.session, "progress")).toBe("Halfway");
    const afterStop = await call(client, "update_issue", { issueId, title: "After stop" });
    expect(afterStop.isError).toBe(true);
    expect(afterStop.data).toMatchObject({ code: "session_required" });

    // REST exposes the same lifecycle with the same key.
    const restIssue = await call(client, "create_issue", { projectId, title: "REST session" });
    const restIssueId = requiredText(field(restIssue.data.issue, "id"), "the REST issue id");
    const restRun = await newRun(client);
    const restClaim = await http.post(`/api/issues/${restIssueId}/work-sessions`, {
      runId: restRun,
    });
    expect(restClaim.status).toBe(201);
    // ADR-0003: REST answers with the resource itself, not a `{ session }` envelope.
    expect(asRecord(await restClaim.json())).toMatchObject({ status: "active" });
    const restProgress = await http.post(`/api/issues/${restIssueId}/work-sessions/progress`, {
      summary: "REST progress",
    });
    expect(restProgress.status).toBe(200);
    expect(asRecord(await restProgress.json())).toMatchObject({ progress: "REST progress" });
    const restEdit = await http.patch(`/api/issues/${restIssueId}`, { title: "REST edit" });
    expect(restEdit.status).toBe(200);
    const restStop = await http.post(`/api/issues/${restIssueId}/work-sessions/stop`, {
      outcome: "released",
    });
    expect(restStop.status).toBe(200);
    expect(asRecord(await restStop.json())).toMatchObject({ status: "released" });
    const restReady = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReady.status).toBe(200);
    const readyRows = await restReady.json();
    expect(Array.isArray(readyRows)).toBe(true);
  } finally {
    await client.close();
  }
});

// #82: a human stop request is a signal on the live session. The holding agent detects it
// on its next heartbeat/progress check-in over MCP, while the request itself is a
// human-only REST action that an agent key cannot perform.
test("a human stop request reaches the agent on renew and progress and is recorded in history", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-stop-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Stop me" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    expect(field(claim.data.session, "stopRequested")).toBe(false);

    // An agent key cannot ask its own operator to stop.
    const denied = await http.post(`/api/issues/${issueId}/work-sessions/stop-request`, {
      reason: "self",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain("application/problem+json");
    expect(asRecord(await denied.json())).toMatchObject({
      code: "agents_cannot_request_stop",
      status: 403,
    });

    // The signed-in human requests the stop with a reason.
    const requested = await api.post(`/api/issues/${issueId}/work-sessions/stop-request`, {
      data: { reason: "Wrong direction" },
    });
    expect(requested.status()).toBe(200);
    expect(asRecord(await requested.json())).toMatchObject({
      status: "active",
      stopRequested: true,
      stopReason: "Wrong direction",
    });

    // The agent sees the signal on both check-ins over MCP.
    const renewed = await call(client, "renew_claim", { issueId });
    expect(renewed.isError).toBe(false);
    expect(field(renewed.data.session, "stopRequested")).toBe(true);
    expect(field(renewed.data.session, "stopReason")).toBe("Wrong direction");
    const progressed = await call(client, "report_progress", {
      issueId,
      summary: "Handoff written",
    });
    expect(progressed.isError).toBe(false);
    expect(field(progressed.data.session, "stopRequested")).toBe(true);

    // The same fact is readable over REST and appears in the project's activity feed.
    const current = await api.get(`/api/issues/${issueId}/work-sessions`);
    expect(current.status()).toBe(200);
    expect(asRecord(await current.json())).toMatchObject({ stopRequested: true });
    const activity = await api.get(`/api/projects/${projectId}/activity`);
    expect(activity.status()).toBe(200);
    expect(
      asArray(await activity.json()).some(
        (event) =>
          field(event, "type") === "issue_stop_requested" &&
          field(event, "summary") === "Wrong direction",
      ),
    ).toBe(true);

    // The agent acknowledges the signal and ends the session; the request stays in history.
    const stopped = await call(client, "stop_session", { issueId, outcome: "released" });
    expect(stopped.isError).toBe(false);
    expect(field(stopped.data.session, "status")).toBe("released");
    expect(field(stopped.data.session, "stopRequested")).toBe(true);
  } finally {
    await client.close();
  }
});

test("clicking Stop agent in the browser transitions the session badge to stopping", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-browser-stop-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  let context;
  try {
    const created = await call(client, "create_issue", { projectId, title: "Browser stop issue" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const runId = await newRun(client);
    expect((await call(client, "claim_issue", { issueId, runId })).isError).toBe(false);

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
    await page.goto(`/issues/${issueId}`);

    const badge = page.locator("[data-session-status]");
    await expect(badge).toHaveText("active");
    await page.getByLabel("Reason (optional)").fill("Browser reason");
    await page.getByRole("button", { name: "Stop agent" }).click();
    await expect(badge).toHaveText("stopping");

    // The agents view lists only live sessions and shows the same stopping badge.
    await page.goto(`/workspaces/${workspaceId}`);
    const agentsBadge = page.locator(
      `[data-agent-session-id][data-issue-id="${issueId}"] [data-session-status]`,
    );
    await expect(agentsBadge).toHaveText("stopping");

    const current = await api.get(`/api/issues/${issueId}/work-sessions`);
    expect(asRecord(await current.json())).toMatchObject({
      stopRequested: true,
      stopReason: "Browser reason",
    });
  } finally {
    if (context !== undefined) {
      for (const cookie of await context.cookies()) await recordSecret(cookie.value);
      await context.close();
    }
    await client.close();
  }
});

test("ready work omits claimed issues and two claims yield one winner", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-racer-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const rival = await connect(secret);
  try {
    const first = await call(client, "create_issue", { projectId, title: "Raced issue" });
    const second = await call(client, "create_issue", { projectId, title: "Other issue" });
    const issueId = requiredText(field(first.data.issue, "id"), "the raced issue id");
    const otherId = requiredText(field(second.data.issue, "id"), "the other issue id");

    const before = await call(client, "ready_work", { projectId });
    expect(asArray(field(before.data, "issues")).map((item) => field(item, "id"))).toEqual(
      expect.arrayContaining([issueId, otherId]),
    );

    // Two distinct runs are two workers on the same issue; only one may claim it.
    const runA = await newRun(client);
    const runB = await newRun(rival);
    const [claimA, claimB] = await Promise.all([
      call(client, "claim_issue", { issueId, runId: runA }),
      call(rival, "claim_issue", { issueId, runId: runB }),
    ]);
    expect([claimA.isError, claimB.isError].filter((failed) => !failed)).toHaveLength(1);
    const refused = claimA.isError ? claimA : claimB;
    expect(refused.data).toMatchObject({ code: "issue_claimed" });

    const after = await call(client, "ready_work", { projectId });
    expect(asArray(field(after.data, "issues")).map((item) => field(item, "id"))).not.toContain(
      issueId,
    );
    expect(asArray(field(after.data, "issues")).map((item) => field(item, "id"))).toContain(
      otherId,
    );
  } finally {
    await client.close();
    await rival.close();
  }
});

test("an open blocker hides ready work until it closes (REST and MCP)", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-deps-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const blocker = await call(client, "create_issue", { projectId, title: "Blocker A" });
    const blocked = await call(client, "create_issue", { projectId, title: "Blocked B" });
    const blockerId = requiredText(field(blocker.data.issue, "id"), "the blocker id");
    const blockedId = requiredText(field(blocked.data.issue, "id"), "the blocked issue id");

    // MCP add and list both directions.
    const added = await call(client, "add_blocked_by", {
      issueId: blockedId,
      blockedByIssueId: blockerId,
    });
    expect(added.isError).toBe(false);
    expect(field(added.data.dependency, "blockedByIssueId")).toBe(blockerId);
    expect(ids((await call(client, "list_blocked_by", { issueId: blockedId })).data)).toContain(
      blockerId,
    );
    expect(ids((await call(client, "list_blocking", { issueId: blockerId })).data)).toContain(
      blockedId,
    );

    // REST sees the same edge; re-adding it is idempotent.
    const restAdd = await http.post(`/api/issues/${blockedId}/blocked-by`, {
      blockedByIssueId: blockerId,
    });
    expect(restAdd.status).toBe(201);
    expect(asRecord(await restAdd.json())).toMatchObject({
      issueId: blockedId,
      blockedByIssueId: blockerId,
    });

    // B is not ready while A is open, over both transports.
    expect(ids((await call(client, "ready_work", { projectId })).data)).not.toContain(blockedId);
    const restReadyBlocked = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReadyBlocked.status).toBe(200);
    expect(asArray(await restReadyBlocked.json()).map((issue) => field(issue, "id"))).not.toContain(
      blockedId,
    );

    // A human closes A; no dependency row is rewritten, so B becomes ready immediately.
    const closed = await api.patch(`/api/issues/${blockerId}`, { data: { status: "closed" } });
    expect(closed.status()).toBe(200);
    expect(ids((await call(client, "ready_work", { projectId })).data)).toContain(blockedId);

    const restReady = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReady.status).toBe(200);
    expect(asArray(await restReady.json()).map((issue) => field(issue, "id"))).toContain(blockedId);

    // REST removal over the same key clears the relation.
    const removed = await http.del(`/api/issues/${blockedId}/blocked-by/${blockerId}`);
    expect(removed.status).toBe(204);
    expect(ids((await call(client, "list_blocked_by", { issueId: blockedId })).data)).toEqual([]);
  } finally {
    await client.close();
  }
});

// #83: ephemeral session telemetry is append-only on the live session, readable over both
// transports, never posted as an issue comment, and streamed into the issue sidecar.
test("session activities stream into the issue sidecar without touching comments", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-activity-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  let context;
  try {
    const created = await call(client, "create_issue", { projectId, title: "Activity issue" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    expect(
      asArray(field((await call(client, "list_comments", { issueId })).data, "comments")),
    ).toEqual([]);

    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    const sessionId = requiredText(field(claim.data.session, "id"), "the session id");

    const thought = await call(client, "log_session_activity", {
      issueId,
      kind: "thought",
      summary: "Planning the fix",
      detail: { step: 1 },
    });
    expect(thought.isError).toBe(false);
    expect(field(thought.data.activity, "workSessionId")).toBe(sessionId);
    expect(field(thought.data.activity, "runId")).toBe(runId);
    expect(field(thought.data.activity, "detail")).toMatchObject({ step: 1 });
    const action = await call(client, "log_session_activity", {
      issueId,
      kind: "action",
      summary: "Edited service.ts",
    });
    expect(action.isError).toBe(false);

    // Both transports read the same newest-first timeline; comments stay empty.
    const listed = await call(client, "list_session_activities", { issueId, sessionId });
    expect(listed.isError).toBe(false);
    expect(asArray(field(listed.data, "activities")).map((entry) => field(entry, "kind"))).toEqual([
      "action",
      "thought",
    ]);
    const restList = await http.get(`/api/issues/${issueId}/work-sessions/${sessionId}/activities`);
    expect(restList.status).toBe(200);
    expect(asArray(await restList.json()).map((entry) => field(entry, "summary"))).toEqual([
      "Edited service.ts",
      "Planning the fix",
    ]);
    expect(
      asArray(field((await call(client, "list_comments", { issueId })).data, "comments")),
    ).toEqual([]);

    // Browser: open the issue and the sidecar inspector; the timeline is polled into view.
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
    await page.goto(`/issues/${issueId}`);
    await page.getByRole("button", { name: "Show session inspector" }).click();
    const timeline = page.locator("[data-activity-timeline]");
    await expect(
      timeline.locator('[data-activity-kind="thought"] [data-activity-summary]'),
    ).toHaveText("Planning the fix", { timeout: 10_000 });
    await expect(
      timeline.locator('[data-activity-kind="action"] [data-activity-summary]'),
    ).toHaveText("Edited service.ts", { timeout: 10_000 });
    await expect(
      timeline.locator('[data-activity-kind="thought"] [data-activity-detail]'),
    ).toContainText('"step": 1', { timeout: 10_000 });

    // Ending the session refuses further appends but never removes the recorded trail.
    const stopped = await call(client, "stop_session", { issueId, outcome: "completed" });
    expect(stopped.isError).toBe(false);
    const refused = await call(client, "log_session_activity", {
      issueId,
      kind: "status",
      summary: "After stop",
    });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ code: "session_required" });
    const afterStop = await call(client, "list_session_activities", { issueId, sessionId });
    expect(asArray(field(afterStop.data, "activities"))).toHaveLength(2);
  } finally {
    if (context !== undefined) {
      for (const cookie of await context.cookies()) await recordSecret(cookie.value);
      await context.close();
    }
    await client.close();
  }
});

test("ready work is ordered by priority over REST and MCP", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-priority-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const low = await call(client, "create_issue", { projectId, title: "Low", priority: "low" });
    const urgent = await call(client, "create_issue", {
      projectId,
      title: "Urgent",
      priority: "urgent",
    });
    const plain = await call(client, "create_issue", { projectId, title: "None" });
    const highRest = await api.post(`/api/projects/${projectId}/issues`, {
      data: { title: "High", priority: "high" },
    });
    expect(highRest.status()).toBe(201);

    const lowId = requiredText(field(low.data.issue, "id"), "the low issue id");
    const urgentId = requiredText(field(urgent.data.issue, "id"), "the urgent issue id");
    const plainId = requiredText(field(plain.data.issue, "id"), "the plain issue id");
    const highId = requiredText(field(await highRest.json(), "id"), "the high issue id");

    // Both transports report the same deterministic queue: urgent > high > low > none.
    const expected = [urgentId, highId, lowId, plainId];
    expect(ids((await call(client, "ready_work", { projectId })).data)).toEqual(expected);
    const restReady = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReady.status).toBe(200);
    expect(asArray(await restReady.json()).map((issue) => field(issue, "id"))).toEqual(expected);

    // A human reprioritizes freely over REST. Low becomes urgent and, having the smaller
    // position, now leads the two urgent cards and the whole queue.
    const moved = await api.patch(`/api/issues/${lowId}`, { data: { priority: "urgent" } });
    expect(moved.status()).toBe(200);
    expect(ids((await call(client, "ready_work", { projectId })).data)).toEqual([
      lowId,
      urgentId,
      highId,
      plainId,
    ]);
  } finally {
    await client.close();
  }
});

// #84: assignment is a pull-queue hint, and the claim stays authoritative. A second key
// on a different registered agent proves the strict refusal over MCP and REST.
test("assignment reserves work for one agent across REST and MCP", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const nameA = `assignee-a-${randomUUID()}`;
  const nameB = `assignee-b-${randomUUID()}`;
  const agentA = await createAgent(api, nameA);
  const agentB = await createAgent(api, nameB);
  const secretA = await issueKey(api, agentA, workspaceId, projectId);
  const secretB = await issueKey(api, agentB, workspaceId, projectId);
  const clientA = await connect(secretA);
  const clientB = await connect(secretB);
  try {
    const created = await call(clientA, "create_issue", { projectId, title: "Reserved work" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const plain = await call(clientA, "create_issue", { projectId, title: "Free work" });
    const plainId = requiredText(field(plain.data.issue, "id"), "the free issue id");
    const assigned = await api.patch(`/api/issues/${issueId}`, {
      data: { assignee: { type: "agent", id: agentA } },
    });
    expect(assigned.status()).toBe(200);
    expect(field(await assigned.json(), "assignee")).toMatchObject({ agentId: agentA });

    // Agent A sees its own issue first and Agent B never sees it in any filter.
    expect(ids((await call(clientA, "ready_work", { projectId })).data)).toEqual([
      issueId,
      plainId,
    ]);
    expect(
      ids((await call(clientA, "ready_work", { projectId, filter: "assignedToMe" })).data),
    ).toEqual([issueId]);
    expect(
      ids((await call(clientA, "ready_work", { projectId, filter: "unassigned" })).data),
    ).toEqual([plainId]);
    expect(ids((await call(clientB, "ready_work", { projectId })).data)).toEqual([plainId]);

    const rejected = await call(clientB, "claim_issue", { issueId, runId: await newRun(clientB) });
    expect(rejected.isError).toBe(true);
    expect(rejected.data.code).toBe("issue_assigned_to_other_agent");
    const restRejected = await bearer(secretB).post(`/api/issues/${issueId}/work-sessions`, {
      runId: await newRun(clientB),
    });
    expect(restRejected.status).toBe(409);
    expect(asRecord(await restRejected.json())).toMatchObject({
      code: "issue_assigned_to_other_agent",
    });

    // The assignee can claim it, and the claim is still one-per-issue.
    expect(
      (await call(clientA, "claim_issue", { issueId, runId: await newRun(clientA) })).isError,
    ).toBe(false);
    const race = await call(clientB, "claim_issue", { issueId, runId: await newRun(clientB) });
    expect(race.isError).toBe(true);
    expect(["issue_claimed", "issue_assigned_to_other_agent"]).toContain(race.data.code);
  } finally {
    await clientA.close();
    await clientB.close();
  }
});

test("assigning to a human refuses an agent claim with a Problem", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `human-assignee-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Human owned" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const members = await api.get(`/api/workspaces/${workspaceId}/members`);
    expect(members.status()).toBe(200);
    const humanId = requiredText(
      field(asArray(await members.json())[0], "humanId"),
      "the human id",
    );
    const assigned = await api.patch(`/api/issues/${issueId}`, {
      data: { assignee: { type: "human", id: humanId } },
    });
    expect(assigned.status()).toBe(200);
    const rejected = await call(client, "claim_issue", { issueId, runId: await newRun(client) });
    expect(rejected.isError).toBe(true);
    expect(rejected.data.code).toBe("issue_assigned_to_human");
    const restRejected = await bearer(secret).post(`/api/issues/${issueId}/work-sessions`, {
      runId: await newRun(client),
    });
    expect(restRejected.status).toBe(409);
    expect(asRecord(await restRejected.json())).toMatchObject({ code: "issue_assigned_to_human" });
  } finally {
    await client.close();
  }
});

test("the board and agents panel show assignment, live session state and the sidecar", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentName = `board-agent-${randomUUID()}`;
  const agentId = await createAgent(api, agentName);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  let context;
  try {
    const created = await call(client, "create_issue", { projectId, title: "Board card" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    expect(
      (await call(client, "claim_issue", { issueId, runId: await newRun(client) })).isError,
    ).toBe(false);

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    // Assign from the issue view; the selector is the workspace's registered agents.
    await page.goto(`/issues/${issueId}`);
    await page.getByLabel("Assignee").selectOption({ label: `Agent · ${agentName}` });
    await page.getByRole("button", { name: "Save assignee" }).click();
    await expect
      .poll(async () => {
        const res = await api.get(`/api/issues/${issueId}`);
        return field(await res.json(), "assignee");
      })
      .toMatchObject({ agentId });

    await page.goto(`/board/${projectId}`);
    const card = page.locator(`[data-board-issue-id="${issueId}"]`);
    await expect(card).toHaveAttribute("data-assignee-type", "agent");
    await expect(card.locator("[data-session-state]")).toHaveText("active");
    await expect(card).toContainText(agentName);

    await page.goto(`/workspaces/${workspaceId}`);
    const sessionRow = page.locator(`[data-agent-session-id][data-issue-id="${issueId}"]`);
    await expect(sessionRow).toHaveAttribute("data-session-harness", "codex");
    await expect(sessionRow.locator("[data-sidecar-link]")).toBeVisible();
    await sessionRow.locator("[data-sidecar-link]").click();
    await expect(page.locator("[data-session-inspector]")).toBeVisible();
    await expect(page.locator("[data-session-inspector] button")).toHaveText(
      "Hide session inspector",
    );
  } finally {
    if (context !== undefined) {
      for (const cookie of await context.cookies()) await recordSecret(cookie.value);
      await context.close();
    }
    await client.close();
  }
});
