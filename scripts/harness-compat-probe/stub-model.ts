// Local-only stub of the Anthropic Messages API. NOT wired into Orrery or CI.
// Use it only to exercise the real Claude Code CLI's MCP/hook plumbing when no valid Claude
// credentials are available. It makes no real model call and proves nothing about model behaviour.
//
//   STUB_MODE=echo node scripts/harness-compat-probe/stub-model.ts
//   STUB_MODE=sleep STUB_SLEEP_MS=310000 node scripts/harness-compat-probe/stub-model.ts
//   STUB_MODE=subagent node scripts/harness-compat-probe/stub-model.ts
//
// Set STUB_PORT_FILE to write the chosen port to a file for the surrounding shell script.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

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

// A stub can make the real CLI re-plan after any text answer. Bound the number of tool calls so a
// local run cannot spin forever; the evidence is the call itself, not the stub model's prose.
let toolCalls = 0;
const MAX_TOOL_CALLS = 20;

const mode = process.env.STUB_MODE ?? "echo";
const logPath = process.env.STUB_LOG ?? "/tmp/orrery-harness-probe/stub-model.jsonl";
const marker = "HARNESS_PROBE_CHILD";

function log(event: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
}

function sendSse(
  response: ServerResponse,
  events: Array<{ event: string; data: Record<string, unknown> }>,
): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const item of events)
    response.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
  response.end();
}

function toolCall(
  response: ServerResponse,
  stream: boolean,
  name: string,
  input: Record<string, unknown>,
): void {
  toolCalls += 1;
  const id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const model = "stub-model";
  if (!stream) {
    const body = JSON.stringify({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }
  sendSse(response, [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name, input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

function textResponse(
  response: ServerResponse,
  stream: boolean,
  model: string,
  text: string,
): void {
  if (!stream) {
    const body = JSON.stringify({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }
  sendSse(response, [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

const server = createServer((request, response) => {
  void (async () => {
    const raw = await readBody(request);
    const parsed = parseJson(raw);
    if (raw && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
      response.writeHead(400);
      response.end();
      return;
    }
    const payload = asRecord(parsed);
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/v1/messages") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ count: 10, data: [{ id: payload.model ?? "stub-model" }] }));
      return;
    }

    const stream = payload.stream !== false;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const lastMessage = asRecord(messages.at(-1));
    const last = lastMessage.content;
    const hasToolResult =
      Array.isArray(last) && last.some((item) => asRecord(item).type === "tool_result");
    const text = safeString(last ?? "");
    // Claude Code marks subagent requests in its system header, not in the user message.
    const isChild =
      text.includes(marker) || safeString(payload.system ?? "").includes("cc_is_subagent=true");
    log({
      path,
      model: payload.model ?? null,
      mode,
      hasToolResult,
      offeredTools: (Array.isArray(payload.tools) ? payload.tools : [])
        .map((tool) => safeString(asRecord(tool).name ?? ""))
        .filter((name) => name.includes("orrery") || name === "Task"),
      isChild,
    });
    if (process.env.STUB_DEBUG_SYSTEM === "1") {
      log({ systemPrefix: safeString(payload.system ?? "").slice(0, 300) });
    }

    if (toolCalls >= MAX_TOOL_CALLS) {
      textResponse(
        response,
        stream,
        safeString(payload.model ?? "stub-model"),
        "Stub model: probe sequence complete.",
      );
      return;
    }

    if (mode === "sleep-poll" && hasToolResult) {
      toolCall(response, stream, "mcp__orrery_probe__probe_poll_heartbeat", {
        token: process.env.STUB_POLL_TOKEN ?? "local-hb",
      });
      return;
    }

    if (hasToolResult) {
      textResponse(
        response,
        stream,
        safeString(payload.model ?? "stub-model"),
        "Stub model: tool result received.",
      );
      return;
    }

    if (isChild) {
      toolCall(response, stream, "mcp__orrery_probe__probe_echo", {
        label: "claude-subagent-child",
        fields: { role: "child" },
      });
    } else if (mode === "sleep" || mode === "sleep-poll") {
      toolCall(response, stream, "mcp__orrery_probe__probe_sleep", {
        durationMs: Number(process.env.STUB_SLEEP_MS ?? 310000),
      });
    } else if (mode === "subagent") {
      toolCall(response, stream, "Task", {
        description: "probe child",
        prompt: `${marker}: call mcp__orrery_probe__probe_echo with label claude-subagent-child.`,
        subagent_type: "general-purpose",
      });
    } else {
      toolCall(response, stream, "mcp__orrery_probe__probe_echo", {
        label: process.env.STUB_LABEL ?? "claude-stub",
        fields: { harness: "claude-code", phase: "stub" },
      });
    }
  })().catch((error: unknown) => {
    log({ error: String(error) });
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

const port = Number(process.env.STUB_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  if (process.env.STUB_PORT_FILE) writeFileSync(process.env.STUB_PORT_FILE, String(actual));
  process.stdout.write(`stub model listening on 127.0.0.1:${actual} (mode ${mode})\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
