// Local-only compatibility probe. NOT imported by apps/server, NOT wired into CI.
// Binds to 127.0.0.1 on an ephemeral port and logs non-secret metadata to a local file.
//
//   node scripts/harness-compat-probe/server.ts
//   PROBE_PORT=0 PROBE_LOG_DIR=/tmp/my-probe node scripts/harness-compat-probe/server.ts
//
// The optional path label (for example /run-A/) and the /checkin/<token> endpoint exist only to
// correlate THIS probe's local log during an experiment. They are not part of Orrery's integration
// contract: the shipped MCP endpoint is a static /mcp with an Authorization: Bearer <agent key>.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

const logDir = process.env.PROBE_LOG_DIR ?? "/tmp/orrery-harness-probe";
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, "events.jsonl");
const portPath = join(logDir, "port.txt");
const label = process.env.PROBE_LABEL ?? "probe";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

let sequence = 0;
function log(event: Record<string, unknown>): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({ seq: ++sequence, t: new Date().toISOString(), ...event })}\n`,
  );
}

// Header values that could carry a credential are redacted before they are logged.
function headerSummary(headers: IncomingMessage["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (["authorization", "cookie", "set-cookie", "proxy-authorization"].includes(name)) {
      const one = Array.isArray(value) ? safeString(value[0]) : safeString(value);
      result[name] = `<redacted:${one.length} chars>`;
      continue;
    }
    if (["host", "user-agent", "content-type", "accept", "mcp-protocol-version"].includes(name)) {
      result[name] = Array.isArray(value) ? value.map(safeString).join(",") : safeString(value);
    }
  }
  return result;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

// Handshake metadata is stored against the local path label, mirroring the proposed contract's
// "capture once on initialize" rule. It is never read from a transport session ID.
const handshakeByLabel = new Map<string, Record<string, unknown>>();
const checkins = new Map<
  string,
  { count: number; beats: Array<{ t: string; latencyMs: number; source: string }> }
>();

const tools = [
  {
    name: "probe_echo",
    description: "Return the observed MCP client metadata and the arguments sent by the client.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" }, fields: { type: "object" } },
    },
  },
  {
    name: "probe_sleep",
    description: "Hold the tool call open for durationMs, then return.",
    inputSchema: {
      type: "object",
      properties: { durationMs: { type: "number" } },
      required: ["durationMs"],
    },
  },
  {
    name: "probe_start_heartbeat",
    description: "Start a server-side timer that beats every intervalMs (baseline only).",
    inputSchema: {
      type: "object",
      properties: { intervalMs: { type: "number" }, durationMs: { type: "number" } },
      required: ["intervalMs", "durationMs"],
    },
  },
  {
    name: "probe_poll_heartbeat",
    description: "Non-blocking poll of a heartbeat token.",
    inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
  },
  {
    name: "probe_wait_heartbeat",
    description: "Block until minCount is reached or timeoutMs elapses.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        minCount: { type: "number" },
        timeoutMs: { type: "number" },
      },
      required: ["token", "minCount", "timeoutMs"],
    },
  },
];

function toolResult(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}

function startServerTimer(params: Record<string, unknown>): string {
  const token = randomUUID();
  const intervalMs = Number(params.intervalMs ?? 10000);
  const durationMs = Number(params.durationMs ?? 360000);
  const state = { count: 0, started: Date.now() };
  checkins.set(token, { count: 0, beats: [] });
  const timer = setInterval(() => {
    if (Date.now() - state.started >= durationMs) {
      clearInterval(timer);
      return;
    }
    state.count += 1;
    const entry = checkins.get(token);
    if (entry) {
      entry.count = state.count;
      entry.beats.push({ t: new Date().toISOString(), latencyMs: 0, source: "server-timer" });
    }
    log({ kind: "server-beat", token, count: state.count, source: label });
  }, intervalMs);
  return token;
}

async function callTool(
  name: string,
  params: Record<string, unknown>,
  pathLabel: string,
): Promise<Record<string, unknown>> {
  const args = asRecord(params.arguments);
  if (name === "probe_echo") {
    const data = {
      tool: name,
      args,
      pathLabel,
      handshake: handshakeByLabel.get(pathLabel) ?? null,
    };
    log({ kind: "tool", ...data });
    return toolResult(JSON.stringify(data));
  }
  if (name === "probe_sleep") {
    const durationMs = Number(args.durationMs ?? 0);
    const id = randomUUID();
    log({ kind: "tool", tool: name, event: "start", id, durationMs, pathLabel });
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    log({ kind: "tool", tool: name, event: "end", id, durationMs, pathLabel });
    return toolResult(JSON.stringify({ id, sleptMs: durationMs }));
  }
  if (name === "probe_start_heartbeat") {
    const token = startServerTimer(args);
    return toolResult(JSON.stringify({ token, source: "server-timer" }));
  }
  if (name === "probe_poll_heartbeat") {
    const token = safeString(args.token ?? "");
    const entry = checkins.get(token);
    const result = entry
      ? { token, count: entry.count, beats: entry.beats.length }
      : { token, error: "unknown token" };
    log({ kind: "poll", ...result, pathLabel });
    return toolResult(JSON.stringify(result));
  }
  if (name === "probe_wait_heartbeat") {
    const token = safeString(args.token ?? "");
    const minCount = Number(args.minCount ?? 1);
    const timeoutMs = Number(args.timeoutMs ?? 0);
    const started = Date.now();
    log({ kind: "wait", event: "start", token, minCount, timeoutMs, pathLabel });
    while (Date.now() - started < timeoutMs && (checkins.get(token)?.count ?? 0) < minCount) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const waitedMs = Date.now() - started;
    const count = checkins.get(token)?.count ?? 0;
    log({ kind: "wait", event: "end", token, waitedMs, count, pathLabel });
    return toolResult(JSON.stringify({ token, waitedMs, count, reached: count >= minCount }));
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

function handleCheckin(path: string, body: string, response: ServerResponse): void {
  const token = decodeURIComponent(path.slice("/checkin/".length));
  const parsed = parseJson(body);
  if (body && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
    json(response, 400, { error: "invalid JSON" });
    return;
  }
  const payload = asRecord(parsed);
  const startedAt = Number(payload.sentAt ?? Date.now());
  const latencyMs = Date.now() - startedAt;
  const entry = checkins.get(token) ?? { count: 0, beats: [] };
  entry.count += 1;
  entry.beats.push({
    t: new Date().toISOString(),
    latencyMs,
    source: safeString(payload.source ?? "unknown"),
  });
  checkins.set(token, entry);
  log({
    kind: "client-checkin",
    token,
    count: entry.count,
    latencyMs,
    source: payload.source ?? "unknown",
    run: payload.run ?? null,
    pathLabel: label,
  });
  json(response, 200, { ok: true, count: entry.count, latencyMs });
}

async function handleMcp(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  pathLabel: string,
): Promise<void> {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(": probe connected\n\n");
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15000);
    request.on("close", () => clearInterval(keepalive));
    return;
  }

  const parsed = parseJson(body);
  if (body && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
    json(response, 400, { error: "invalid JSON" });
    return;
  }
  const rpc = asRecord(parsed);
  log({
    kind: "http",
    method: request.method,
    rpcMethod: rpc.method ?? null,
    pathLabel,
    headers: headerSummary(request.headers),
  });

  if (safeString(rpc.method ?? "").startsWith("notifications/")) {
    log({ kind: "notification", method: rpc.method, pathLabel });
    response.writeHead(202);
    response.end();
    return;
  }

  // Send response headers immediately. This satisfies the HTTP per-request "time to first byte"
  // timers that Claude Code applies to remote MCP servers, even for a multi-minute tool call.
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let result: Record<string, unknown>;
  if (rpc.method === "initialize") {
    const params = asRecord(rpc.params);
    const clientInfo = asRecord(params.clientInfo);
    handshakeByLabel.set(pathLabel, {
      clientInfo,
      capabilities: params.capabilities ?? null,
      protocolVersion: params.protocolVersion ?? null,
      userAgent: request.headers["user-agent"] ?? null,
    });
    log({ kind: "initialize", pathLabel, ...handshakeByLabel.get(pathLabel) });
    result = {
      protocolVersion: params.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "orrery-harness-compat-probe", version: "0.1.0-local" },
    };
  } else if (rpc.method === "server/discover") {
    result = {};
  } else if (rpc.method === "tools/list") {
    result = { tools };
  } else if (rpc.method === "tools/call") {
    const callParams = asRecord(rpc.params);
    result = await callTool(safeString(callParams.name ?? ""), callParams, pathLabel);
  } else {
    result = { error: { code: -32601, message: "Method not found" } };
  }
  response.write(
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result })}\n\n`,
  );
  response.end();
}

const port = Number(process.env.PROBE_PORT ?? 0);
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const pathLabel = path === "/" ? label : path.replace(/^\/+|\/+$/g, "");
  void (async () => {
    const body = await readBody(request);
    if (path.startsWith("/checkin/")) {
      handleCheckin(path, body, response);
    } else if (path === "/health") {
      json(response, 200, { ok: true });
    } else {
      await handleMcp(request, response, body, pathLabel);
    }
  })().catch((error: unknown) => {
    log({ kind: "error", message: String(error) });
    if (!response.headersSent) json(response, 500, { error: "probe failed" });
    else response.end();
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  writeFileSync(portPath, String(actual));
  log({ kind: "listening", port: actual, label, logDir });
  process.stdout.write(`probe listening on 127.0.0.1:${actual}; log ${logPath}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
