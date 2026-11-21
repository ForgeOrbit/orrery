// #106 black-box browser proof for the M4 rich-content surfaces: safe GFM Markdown and
// Mermaid in issue descriptions/comments, the four v1 activity block renderers with a
// collapsible JSON fallback, and optional token/cost display that never shows fake zeroes.
// Drives the real image like a person would; nothing here imports server or web code.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Browser } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

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
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return requiredText(field(personal, "id"), "the personal workspace id");
}

async function newProject(workspaceId: string): Promise<string> {
  const res = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Rich content ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the project id");
}

async function newIssue(projectId: string, body: string): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: `Rich issue ${randomUUID()}`, body },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the issue id");
}

// An agent key issues the bearer calls that create a run, claim the issue, report
// telemetry and append activities. Keeping this separate from the human cookie jar
// mirrors how a real agent feeds the sidecar.
async function agentFor(projectId: string, workspaceId: string) {
  const agentRes = await api.post("/api/agents", {
    data: { name: `rich-agent-${randomUUID()}` },
  });
  expect(agentRes.status()).toBe(201);
  const agentId = requiredText(field(await agentRes.json(), "id"), "the agent id");
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const secret = requiredText(field(await keyRes.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return {
    post: (path: string, body: unknown) =>
      fetch(new URL(path, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
      }),
  };
}

type Agent = Awaited<ReturnType<typeof agentFor>>;

async function claim(agent: Agent, issueId: string) {
  const run = await agent.post("/api/runs/hook", {
    schema: "orrery.run.hook.v1",
    event: "run_started",
    runKey: { harness: "codex", nativeSessionId: randomUUID() },
  });
  expect(run.status).toBe(200);
  const runId = requiredText(field(await run.json(), "runId"), "the run id");
  const claimed = await agent.post(`/api/issues/${issueId}/work-sessions`, { runId });
  expect(claimed.status).toBe(201);
  const session = await claimed.json();
  return {
    runId,
    sessionId: requiredText(field(session, "id"), "the session id"),
  };
}

async function signIn(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
  return { context, page };
}

async function closeBrowser(context: Awaited<ReturnType<typeof signIn>>["context"]) {
  for (const cookie of await context.cookies()) await recordSecret(cookie.value);
  await context.close();
}

test("renders GFM Markdown and Mermaid safely in issue bodies and comments", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceId();
  const projectId = await newProject(workspaceId);
  const marker = randomUUID();
  const body = [
    "## GFM",
    "",
    "| Feature | Status |",
    "| --- | --- |",
    "| tables | yes |",
    "",
    "- [x] task done",
    "- [ ] task open",
    "",
    "~~old text~~ and **bold**.",
    "",
    "`const x = 1;`",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "```mermaid",
    "graph LR",
    "  A[Start] --> B[Finish]",
    "```",
    "",
    "[safe link](https://example.com) and [unsafe](javascript:window.orreryXssMarker='link')",
    "",
    "[control char](java&#9;script:window.orreryXssMarker='tab')",
    "",
    "[entity](&#1;javascript:window.orreryXssMarker='entity')",
    "",
    "[data link](data:text/html;base64,PHNjcmlwdD4=)",
    "",
    '<script>window.orreryXssMarker = "script";</script>',
    "",
    `<img src=x onerror="window.orreryXssMarker = 'img';">`,
    "",
    `Raw marker ${marker}.`,
  ].join("\n");
  const issueId = await newIssue(projectId, body);
  const commentPosted = await api.post(`/api/issues/${issueId}/comments`, {
    data: { body: "## Comment\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~" },
  });
  expect(commentPosted.ok()).toBe(true);

  const { context, page } = await signIn(browser);
  try {
    await page.goto(`/issues/${issueId}`);
    const bodyRoot = page.locator("[data-issue-body] [data-markdown]");

    // GFM features in the description.
    await expect(bodyRoot.locator("table th")).toHaveText(["Feature", "Status"]);
    await expect(bodyRoot.locator("table td")).toContainText(["tables", "yes"]);
    await expect(bodyRoot.locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(bodyRoot.locator('input[type="checkbox"]').first()).toBeChecked();
    await expect(bodyRoot.locator('input[type="checkbox"]').first()).toBeDisabled();
    await expect(bodyRoot.locator("del")).toHaveText("old text");
    await expect(bodyRoot.locator("[data-code-block] code")).toContainText("const answer = 42;");
    await expect(bodyRoot.locator('a[href="https://example.com"]')).toBeVisible();

    // Fenced Mermaid becomes an actual SVG, rendered asynchronously without useEffect.
    await expect(bodyRoot.locator("[data-mermaid] svg")).toBeVisible({ timeout: 15_000 });

    // Raw HTML is inert: no script/img from the source reaches the DOM and no handler ran.
    await expect(bodyRoot.locator("script")).toHaveCount(0);
    await expect(bodyRoot.locator("img[onerror]")).toHaveCount(0);
    // Entity-decoded control characters and data: URLs cannot become link targets.
    await expect(bodyRoot.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
    await expect(bodyRoot).toContainText(`Raw marker ${marker}.`);
    expect(await page.evaluate(() => Reflect.get(globalThis, "orreryXssMarker"))).toBeUndefined();

    // Comments use the same safe renderer.
    const comment = page.locator("[data-comment-body] [data-markdown]");
    await expect(comment.locator("table th")).toHaveText(["A", "B"]);
    await expect(comment.locator("del")).toHaveText("gone");
    await expect(comment.locator("script")).toHaveCount(0);
  } finally {
    await closeBrowser(context);
  }
});

test("renders v1 activity blocks, JSON fallback and optional cost telemetry", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceId();
  const projectId = await newProject(workspaceId);
  const agent = await agentFor(projectId, workspaceId);

  const issueId = await newIssue(projectId, "Inspector rich content");
  const { sessionId } = await claim(agent, issueId);
  const renewed = await agent.post(`/api/issues/${issueId}/work-sessions/renew`, {
    inputTokens: 100,
    outputTokens: 20,
  });
  expect(renewed.ok).toBe(true);
  const progressed = await agent.post(`/api/issues/${issueId}/work-sessions/progress`, {
    summary: "Cost reported",
    costUsdMicros: 12_300,
  });
  expect(progressed.ok).toBe(true);

  const blocks = [
    {
      version: 1,
      type: "key_value",
      items: [{ key: "branch", value: "main" }],
    },
    {
      version: 1,
      type: "table",
      columns: ["tool", "version"],
      rows: [["node", "26"]],
    },
    {
      version: 1,
      type: "checklist",
      items: [{ label: "tests pass", checked: true }],
    },
    {
      version: 1,
      type: "test_results",
      passed: 3,
      failed: 1,
      skipped: 1,
      cases: [{ name: "adds", status: "passed" }],
    },
  ];
  for (const [index, block] of blocks.entries()) {
    const res = await agent.post(`/api/issues/${issueId}/work-sessions/activities`, {
      kind: "status",
      summary: `Block ${index}`,
      detail: { source: "e2e", block },
    });
    expect(res.status).toBe(201);
  }
  // Custom harness telemetry without a v1 block takes the collapsible JSON fallback.
  // A present block is validated by the contract, so an unversioned block can only
  // arrive as legacy data; the UI guards for that defensively.
  const custom = await agent.post(`/api/issues/${issueId}/work-sessions/activities`, {
    kind: "thought",
    summary: "Custom detail",
    detail: { tool: "edit", nested: { step: 1 } },
  });
  expect(custom.status).toBe(201);

  // A second session that never reported telemetry must hide every telemetry field.
  const nullIssueId = await newIssue(projectId, "No telemetry");
  const { sessionId: nullSessionId } = await claim(agent, nullIssueId);

  const { context, page } = await signIn(browser);
  try {
    await page.goto(`/issues/${issueId}?inspector=true`);
    const inspector = page.locator("[data-session-inspector]");
    await expect(inspector).toBeVisible();

    await expect(inspector.locator('[data-activity-block="key_value"]')).toContainText("main");
    await expect(
      inspector.locator('[data-activity-block="table"] [data-activity-block-kind="table"]'),
    ).toBeVisible();
    await expect(inspector.locator('[data-activity-block="table"] table')).toContainText("node");
    await expect(
      inspector.locator('[data-activity-block="checklist"] li[data-checked="true"]'),
    ).toContainText("tests pass");
    await expect(inspector.locator('[data-activity-block="test_results"]')).toContainText(
      "3 passed",
    );
    await expect(inspector.locator('[data-activity-block="test_results"]')).toContainText(
      "1 failed",
    );
    await expect(inspector.locator('[data-activity-block="test_results"]')).toContainText(
      "1 skipped",
    );

    // The fallback is collapsed until the reader opens it, then shows inert JSON.
    const fallback = inspector.locator('[data-activity-block="json"]');
    await expect(fallback).toHaveCount(1);
    await fallback.getByRole("button", { name: "Raw activity detail (JSON)" }).click();
    await expect(fallback.locator("[data-activity-detail]")).toContainText('"tool": "edit"');
    // Reported telemetry is shown, formatted as dollars, on the inspector.
    await expect(inspector.locator("[data-telemetry-input-tokens]")).toHaveText("100");
    await expect(inspector.locator("[data-telemetry-output-tokens]")).toHaveText("20");
    await expect(inspector.locator("[data-telemetry-cost]")).toHaveText("$0.0123");

    // The agents panel shows the same reported cost on the live-session row.
    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();
    const reportedRow = page.locator(`[data-agent-session-id="${sessionId}"]`);
    await expect(reportedRow.locator("[data-telemetry-cost]")).toHaveText("cost: $0.0123");

    // A session with no reported values shows no telemetry anywhere: no fake zeroes.
    await page.goto(`/issues/${nullIssueId}?inspector=true`);
    await expect(page.locator("[data-session-inspector] [data-telemetry-cost]")).toHaveCount(0);
    await expect(
      page.locator("[data-session-inspector] [data-telemetry-input-tokens]"),
    ).toHaveCount(0);
    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();
    const nullRow = page.locator(`[data-agent-session-id="${nullSessionId}"]`);
    await expect(nullRow.locator("[data-telemetry-cost]")).toHaveCount(0);
    await expect(nullRow.locator("[data-telemetry-input-tokens]")).toHaveCount(0);
  } finally {
    await closeBrowser(context);
  }
});
