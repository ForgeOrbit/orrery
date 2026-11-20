// Real-CLI gate for Claude Code run reporting (issue #44). NOT wired into CI.
//
// Starts an isolated real Orrery (its own Postgres container and HTTP port), the local
// probe MCP server and the local stub model, then drives the real `claude` CLI through
// concurrent conversations, a subagent and a resume. It verifies the persisted runs
// through GET /api/workspaces/:workspaceId/runs. No real Claude model call is made: this
// host's OAuth session is expired, so the stub proves only CLI/hook/MCP plumbing.
//
//   node scripts/claude-code-gate.mjs
//
// Requires docker, node 26 and `claude` on PATH. Secrets stay in the temp work dir and
// are never written into the repo or the logs printed here.
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hookPath = join(root, "scripts/claude-code-report-hook.mjs");
const stubPath = join(root, "scripts/harness-compat-probe/stub-model.ts");
const base = process.env.TMPDIR ?? tmpdir();
const work = join(base, `orrery-claude44-${randomBytes(4).toString("hex")}`);
mkdirSync(work, { recursive: true });

const log = (line) => process.stdout.write(`${line}\n`);
const cmd = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

function start(file, args, env, label) {
  const descriptor = openSync(join(work, `${label}.log`), "w");
  const child = spawn(file, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const write = (chunk) => appendFileSync(descriptor, String(chunk));
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  return child;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function ready(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${new URL(url).pathname}`);
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${new URL(url).pathname}: ${res.status} ${await res.text()}`);
  return res;
}

function text(value, what) {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

const children = [];
const cleanup = () => {
  for (const child of children.toReversed()) child.kill("SIGTERM");
};
process.on("exit", cleanup);

async function claude({ prompt, configDir, mcpPath, settingsPath, stubPort, resumeId, env }) {
  const args = [
    "-p",
    prompt,
    "--mcp-config",
    mcpPath,
    "--strict-mcp-config",
    "--settings",
    settingsPath,
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    "6",
    "--output-format",
    "json",
  ];
  if (resumeId) args.push("--resume", resumeId);
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubPort}`,
      ANTHROPIC_API_KEY: "local-stub-not-a-real-key",
      CLAUDE_CONFIG_DIR: configDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.slice(0, 1000)}`);
  const parsed = JSON.parse(stdout);
  return { sessionId: text(parsed.session_id, "claude session_id"), result: parsed.result };
}

async function main() {
  const pgPassword = `gate${randomBytes(6).toString("hex")}`;
  const pgName = `orrery-gate44-${randomBytes(4).toString("hex")}`;
  log(`work dir: ${work}`);

  cmd("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    pgName,
    "-e",
    `POSTGRES_PASSWORD=${pgPassword}`,
    "-e",
    "POSTGRES_USER=orrery",
    "-e",
    "POSTGRES_DB=orrery",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  ]);
  const pgPort = cmd("docker", ["port", pgName, "5432/tcp"])
    .trim()
    .split("\n")
    .at(-1)
    .split(":")
    .at(-1);
  for (let i = 0; i < 120; i++) {
    try {
      cmd("docker", ["exec", pgName, "pg_isready", "-U", "orrery", "-d", "orrery"]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const setupSecret = randomBytes(32).toString("hex");
  const adminPassword = `GatePass${randomBytes(6).toString("hex")}!`;
  const encryptionKey = randomBytes(32).toString("base64");
  const server = start(
    process.execPath,
    ["apps/server/src/main.ts"],
    {
      PORT: String(port),
      DATABASE_URL: `postgres://orrery:${pgPassword}@127.0.0.1:${pgPort}/orrery`,
      PUBLIC_URL: origin,
      BOOTSTRAP_SECRET: setupSecret,
      ORRERY_ENCRYPTION_KEY: encryptionKey,
      LOG_LEVEL: "error",
    },
    "server",
  );
  children.push(server);
  await ready(`${origin}/readyz`);

  await post(`${origin}/api/setup/admin`, {
    secret: setupSecret,
    email: "gate44@example.com",
    password: adminPassword,
  });
  const login = await post(`${origin}/api/auth/login`, {
    email: "gate44@example.com",
    password: adminPassword,
  });
  const cookie = text(login.headers.getSetCookie()[0]?.split(";")[0], "session cookie");
  const auth = { Cookie: cookie };

  const workspaces = await (await fetch(`${origin}/api/workspaces`, { headers: auth })).json();
  const workspaceId = text(workspaces.find((w) => w.kind === "personal")?.id, "workspace id");
  const agent = await (
    await post(`${origin}/api/agents`, { name: `claude-gate-${randomUUID()}` }, auth)
  ).json();
  const agentId = text(agent.id, "agent id");
  const keyResponse = await (
    await post(
      `${origin}/api/agents/keys`,
      { agentId, workspaceId, validity: "90", projects: [] },
      auth,
    )
  ).json();
  const apiKey = text(keyResponse.secret, "agent key secret");

  // One shared static MCP config and one shared hook settings: concurrent terminals use
  // the same real /mcp URL and key, exactly as the proposed contract requires.
  const configDir = join(work, "claude-config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        orrery: {
          type: "http",
          url: `${origin}/mcp`,
          headers: { Authorization: "Bearer ${ORRERY_API_KEY}" },
        },
      },
    }),
  );
  const command = `node ${hookPath}`;
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "SessionEnd",
  ];
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({
      hooks: Object.fromEntries(
        events.map((name) => [name, [{ hooks: [{ type: "command", command }] }]]),
      ),
    }),
  );
  const hookEnv = { ORRERY_URL: origin, ORRERY_API_KEY: apiKey, ORRERY_HOOK_TIMEOUT_MS: "3000" };

  const stubPort = await freePort();
  const stubEnv = {
    STUB_PORT: String(stubPort),
    STUB_LOG: join(work, "stub-echo.jsonl"),
    STUB_MODE: "echo",
    STUB_TOOL: "mcp__orrery__list_projects",
    STUB_TOOL_INPUT: "{}",
  };
  const stub = start(process.execPath, [stubPath], stubEnv, "stub-echo");
  children.push(stub);
  await ready(`http://127.0.0.1:${stubPort}/v1/models`);

  log("phase 1: two concurrent Claude Code conversations");
  const [first, second] = await Promise.all([
    claude({
      prompt: "call mcp__orrery__list_projects once",
      configDir: join(configDir, "a"),
      mcpPath: join(configDir, "mcp.json"),
      settingsPath: join(configDir, "settings.json"),
      stubPort,
      env: hookEnv,
    }),
    claude({
      prompt: "call mcp__orrery__list_projects once",
      configDir: join(configDir, "b"),
      mcpPath: join(configDir, "mcp.json"),
      settingsPath: join(configDir, "settings.json"),
      stubPort,
      env: hookEnv,
    }),
  ]);
  log(`  sessions: ${first.sessionId} ${second.sessionId}`);

  log("phase 2: resume the first conversation");
  const resumed = await claude({
    prompt: "call mcp__orrery__list_projects once after a resume",
    // Same config dir as the original: Claude Code stores its transcript there.
    configDir: join(configDir, "a"),
    mcpPath: join(configDir, "mcp.json"),
    settingsPath: join(configDir, "settings.json"),
    stubPort,
    resumeId: first.sessionId,
    env: hookEnv,
  });

  stub.kill("SIGTERM");
  await new Promise((resolve) => stub.once("close", resolve));
  const childPort = await freePort();
  const childStub = start(
    process.execPath,
    [stubPath],
    {
      STUB_PORT: String(childPort),
      STUB_LOG: join(work, "stub-child.jsonl"),
      STUB_MODE: "subagent",
      STUB_TOOL: "mcp__orrery__list_projects",
      STUB_TOOL_INPUT: "{}",
    },
    "stub-subagent",
  );
  children.push(childStub);
  await ready(`http://127.0.0.1:${childPort}/v1/models`);

  log("phase 3: spawn a subagent");
  const withChild = await claude({
    prompt:
      "Use the Agent tool to spawn a general-purpose subagent that calls mcp__orrery__list_projects",
    configDir: join(configDir, "child"),
    mcpPath: join(configDir, "mcp.json"),
    settingsPath: join(configDir, "settings.json"),
    stubPort: childPort,
    env: hookEnv,
  });

  const listed = await (
    await fetch(`${origin}/api/workspaces/${workspaceId}/runs`, { headers: auth })
  ).json();
  const mine = listed.runs.filter((run) => run.agentId === agentId);
  const bySession = (sessionId) => mine.filter((run) => run.nativeSessionId === sessionId);
  const resumedRuns = bySession(resumed.sessionId);
  const childRuns = bySession(withChild.sessionId);
  const result = {
    claudeVersion: cmd("claude", ["--version"]).trim(),
    agentId,
    workspaceId,
    sessions: {
      concurrentA: first.sessionId,
      concurrentB: second.sessionId,
      resumed: resumed.sessionId,
      subagent: withChild.sessionId,
    },
    runCount: mine.length,
    runs: mine.map((run) => ({
      id: run.id,
      nativeSessionId: run.nativeSessionId,
      harness: run.harness,
      harnessVersion: run.harnessVersion,
      model: run.model,
      status: run.status,
      children: run.children.map((child) => ({
        agentId: child.agentId,
        agentType: child.agentType,
        status: child.status,
      })),
    })),
  };
  writeFileSync(join(work, "results.json"), `${JSON.stringify(result, null, 2)}\n`);

  const checks = [];
  const check = (name, ok) => {
    checks.push({ name, ok });
    log(`  ${ok ? "PASS" : "FAIL"} ${name}`);
  };
  check(
    "two concurrent conversations are distinct runs",
    bySession(first.sessionId).length === 1 &&
      bySession(second.sessionId).length === 1 &&
      first.sessionId !== second.sessionId,
  );
  check(
    "resume reuses the same run",
    resumedRuns.length === 1 && resumed.sessionId === first.sessionId,
  );
  check("subagent conversation is its own run", childRuns.length === 1);
  check(
    "every run is harness claude-code",
    mine.every((run) => run.harness === "claude-code"),
  );
  check(
    "missing model stays null (unknown)",
    mine.every((run) => run.model === null),
  );
  check(
    "missing harness version stays null (unknown)",
    mine.every((run) => run.harnessVersion === null),
  );
  check(
    "child carries agent id and type",
    childRuns[0]?.children.some(
      (child) => child.agentId && child.agentType === "general-purpose",
    ) === true,
  );
  log(`results: ${join(work, "results.json")}`);
  if (checks.some((entry) => !entry.ok)) throw new Error("gate checks failed");
  log("GATE PASSED");
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    // Remove the Postgres container explicitly; local children are stopped above.
    try {
      cmd("docker", ["ps", "-a", "--filter", "name=orrery-gate44-", "--format", "{{.Names}}"])
        .trim()
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => cmd("docker", ["rm", "-f", name]));
    } catch {
      // Best effort cleanup.
    }
    // Open sockets from the spawned CLIs keep the event loop alive otherwise.
    process.exit(process.exitCode ?? 0);
  });
