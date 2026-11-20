# Harness compatibility proof: Claude Code and Codex

This is the bounded compatibility proof for [issue #29](https://github.com/forge-orbit/orrery/issues/29)
and its parent [spec, issue #20](https://github.com/forge-orbit/orrery/issues/20). It records local
gate runs against the two harnesses we intend to support first. It is **evidence and a proposed
contract**, not a shipped feature: no run tracking is implemented by this page.

## What was tested

| Harness | Version exercised | Model provider during the probe | Result |
| --- | --- | --- | --- |
| Codex CLI | `codex-cli 0.171.0` | Real credentials; hooks reported model `gpt-6.2-sol` | All probes ran live with real model calls. |
| Claude Code CLI | `2.1.329 (Claude Code)` | No valid session on this host. | Real CLI plumbing, **local stub model endpoint**. No real Claude model call. |

Codex results are live, model-driven calls. Claude Code results prove what the real CLI sends over
MCP and to hooks; the stub model's text is not evidence about a real model. The first live Claude
probe returned the exact error
`Failed to authenticate: OAuth session expired and could not be refreshed`. The live
Claude model-metadata check remains outstanding. [Issue #44](https://github.com/forge-orbit/orrery/issues/44)
rechecked those credentials on 2026-11-20 and got the same error, then wired the CLI and verified
its hook and static-MCP plumbing against a real local Orrery using the stub model; see
[Claude Code run reporting](../guides/claude-code-runs.md).

## Local probe harness

The proof is repeatable with committed, standalone scripts in `scripts/harness-compat-probe/`:

| Script | Role |
| --- | --- |
| `server.ts` | Loopback-only MCP probe with `probe_echo`, `probe_sleep`, `probe_start_heartbeat`, `probe_poll_heartbeat` and `probe_wait_heartbeat`, plus a non-MCP `/checkin/<token>` endpoint for a client-side process. |
| `heartbeat.ts` | A **separate OS process** that POSTs timestamped check-ins to the probe every interval and records round-trip latency. |
| `stub-model.ts` | A local stub Anthropic Messages endpoint, used only to drive the real Claude Code CLI when no credentials exist. |

None of these scripts is imported by `apps/server`, wired into CI or mounted on the production MCP
endpoint. They bind to `127.0.0.1` on OS-assigned ephemeral ports, redact credential-shaped headers
before logging, and write only non-secret metadata to `/tmp/orrery-harness-probe/`. The optional
path label (for example `/run-A/`) and the `/checkin/<token>` URL exist **only to correlate this
probe's local log**. They are not part of Orrery's integration contract.

See [Reproducing the gate](#reproducing-the-gate) for exact commands.

## Handshake identity

The `initialize` request is the only MCP message that reliably names the client. With a stateless
transport, a new server instance handles each HTTP request: on `tools/call`, both
`getClientVersion()` and `getClientCapabilities()` were `null` for both CLIs. Capture handshake
metadata once and store it against the harness's native session key; do not try to read it during a
tool call. The local probe demonstrates this by returning the stored handshake in `probe_echo`.

| Field | Codex CLI | Claude Code CLI |
| --- | --- | --- |
| `clientInfo.name` | `codex-mcp-client` | `claude-code` |
| `clientInfo.title` | `Codex` | `Claude Code` |
| `clientInfo.version` | `0.171.0` | `2.1.329` |
| `clientInfo.description` / `websiteUrl` | absent | present (Anthropic's agentic coding tool / claude.com) |
| negotiated MCP protocol version | `2025-06-18` | `2025-11-25` |
| declared capabilities | `elicitation` (form, url) | `roots` (listChanged), `elicitation` (form, url) |
| User-Agent | `codex-mcp-client/0.171.0` | `claude-code/2.1.329 (sdk-cli)` |
| extra handshake traffic | none observed | a `server/discover` request advertising MCP protocol version `2026-07-28`, then a `GET` SSE listener on the endpoint |

Harness name and version from `clientInfo` are reliable. The model is **not** in either MCP
handshake.

## Conversations, children and resume

**Concurrent conversations.** Two Codex processes ran at the same time with different local probe
path labels. Their hook `session_id` values were distinct, their MCP requests interleaved, and
their handshakes were identical. Two Claude Code processes behaved the same way. The two terminals
used different labels only because this local probe needs to separate its log lines; in production
they would use the same static `/mcp` URL and be told apart by their harness session IDs.

**Spawned subagent.** Codex with `--enable multi_agent` spawned a child using its literal built-in
tools `collaborationspawn_agent` and `collaborationwait_agent`. The child's tool call reached the
same MCP endpoint and the same parent `session_id`; only the hook payload for that call carried
`agent_id` (`01a1f6bd-4995-7b01-aa8b-fc78992f5713`) and `agent_type` (`default`). Nothing in the
MCP request identified the child.

Claude Code launched an `Agent` subagent asynchronously; the parent's `PostToolUse` hook reported
`status: async_launched`, an `agentId` and a `resolvedModel`. The child's `probe_echo` call reached
the same local MCP path label, while the child's `PreToolUse`/`PostToolUse` hooks carried
`agent_id: a0d5e888b4be56d01` and `agent_type: general-purpose` alongside the parent `session_id`.
The stubbed child tool sequence looped until the local run timeout; that is a stub artifact, not a
CLI finding. The attribution fields are the evidence.

**Resumed conversation.** `codex exec resume <session-id>` reused the same hook `session_id` and
produced a fresh `initialize`; `claude -p --resume <session-id>` also kept the same hook
`session_id`. A resume maps onto a *new MCP handshake for the same run*, not a new run.

## Timing, timeouts, heartbeat and polling

All timings are local, wall-clock measurements from the probe, hook and heartbeat logs on
2026-11-20 (UTC).

| Measurement | Result |
| --- | --- |
| Codex, `tool_timeout_sec = 400`, `probe_sleep(310000)` | Server-side call started `02:45:10.671Z`, ended `02:50:20.705Z` (**310,034 ms**). The call exceeded five minutes and completed. |
| Codex, non-blocking poll after that call | `probe_poll_heartbeat` returned in **18 ms** with `count: 21`. |
| Client-side heartbeat, both CLIs | A separate `heartbeat.ts` process posted to `/checkin/<token>` every 15 s for 360 s while each CLI was blocked on its 310 s tool call. Each process recorded **23 beats**; average round-trip **4 ms**, maximum **42 ms** (Codex) and **37 ms** (Claude). The probe accepted all 23. This is a real client-side process, not a timer inside the MCP server. |
| Hooks during the long calls | `PreToolUse` at the start and `PostToolUse` at the end only. **Hooks are point-in-time events, not a continuous heartbeat.** |
| Claude Code, stub model, per-server `timeout: 600000`, `MCP_TOOL_TIMEOUT=600000`, idle check disabled | `probe_sleep(310000)` started `02:45:00.868Z` and ended `02:50:10.868Z` (**310,000 ms**). The raised timeout allowed a >5-minute call to complete. |
| Claude Code, stub model, per-server `timeout: 30000`, `probe_sleep(90000)` | Call started `02:50:45.584Z`; Claude Code sent `notifications/cancelled` at `02:51:15.610Z` (**~30 s**). The server-side call did not log an end at 90 s in this run. |
| Codex, explicit `tool_timeout_sec = 30` against `probe_sleep(90000)` (earlier committed-probe predecessor run) | Client failed after **30.026 s** with `timed out awaiting tools/call after 30s` and sent `notifications/cancelled` at +30 s; the server-side tool still ran to +90 s. Client cancellation does not necessarily stop server work. |
| Codex, default MCP server config | A `probe_wait_heartbeat(..., timeoutMs: 120000)` returned normally after **120,077 ms** with no timeout error. Measure the real client rather than assuming a documented default. |
| Claude Code, stub model, default per-server MCP config (earlier run), `probe_sleep(95000)` | Completed in **95,005 ms** with no timeout or cancellation. The probe sends SSE headers immediately, satisfying Claude Code's HTTP first-byte timer; a server that buffers to the end should not assume the same. |
| Codex, non-blocking wait | `probe_wait_heartbeat(minCount: 3, timeoutMs: 30000)` returned after **3,612 ms** with `reached: true`; the following poll took **31 ms**. |

A long call can be kept alive by an explicit client-side check-in process or by server progress
notifications. Hooks alone cannot do it. Do not design a five-minute claim lease around hook
events.

## What can be captured, and what stays unknown

| Field | Source judged reliable | When the source is missing |
| --- | --- | --- |
| Harness name and version | `clientInfo` on `initialize`, cross-checked with User-Agent | `unknown` |
| Agent identity | authenticated Orrery API key, never a reported name | request is unauthorized |
| Run identity | `(harness, native_session_id)` from a hook, or an explicit `runId` argument | `unknown`; never the MCP transport session ID |
| Model | hook `model` field (Codex reported `gpt-6.2-sol`) | `unknown` |
| Model changes over a run | successive hook `model` values, recorded as events | `unknown` |
| Parent/child | Codex hook `agent_id` / `agent_type`; Claude `Agent` hook `agentId` / `resolvedModel` | `unknown` |
| Transcript content | not captured; private transcripts stay on the machine | not applicable |

The model must not be inferred from an agent's display name. In one probe the model described
itself as `GPT-6` while the local hook reported `gpt-6.2-sol`; treat self-description as unverified
text, not metadata. A client-reported field that a hook cannot confirm stays `unknown` rather than
being synthesised.

## Minimal integration contract

This is the smallest contract the run-tracking slice needs. It is **proposed and unshipped**.
[Issue #34](https://github.com/forge-orbit/orrery/issues/34) defines the server side;
[issue #44](https://github.com/forge-orbit/orrery/issues/44) and
[issue #45](https://github.com/forge-orbit/orrery/issues/45) wire the CLIs.

1. **Static endpoint and one credential.** Users run `claude` and `codex` directly against one
   static MCP URL, `/mcp`, configured once in `.mcp.json` or `~/.codex/config.toml` with
   `Authorization: Bearer <agent-api-key>`. No wrapper is required. Two concurrent terminals in
   the same repository share that URL, and a child worker uses the same URL as its parent, so the
   URL, the transport session ID and the bearer key cannot distinguish runs. The bearer key
   identifies the *agent* and scopes the workspace.
2. **Harness hooks report run and child lifecycle.** A locally configured hook for each CLI POSTs
   the event below to a REST endpoint with the same agent API key. The stable key is
   `(harness, native_session_id)`: it is distinct across concurrent conversations and stable
   across resumes. `agent_id` / `agent_type` mark child work; `model` is reported metadata. Missing
   optional values are stored as `unknown`.
3. **Explicit correlation is additive, not required.** When a `SessionStart` hook is installed it
   can register or resume a run and inject its `runId` (or the harness `session_id`) into the
   agent's context. MCP work-session tools then pass `runId` explicitly as a tool argument. When
   hooks are absent, the agent still works through static `/mcp`; `run`, `model` and `harness` stay
   `unknown`, or an explicit `orrery_run_checkin` tool can start a run. Graceful degradation is the
   requirement, not mandatory wrapping.
4. **Check-in over MCP.** Long calls send short explicit check-ins or progress messages so a lease
   can be renewed without waiting for the tool result. Five-minute claim leases and one-hour
   question deadlines are server policy and do not depend on a tool call returning.

### Hook event POST body (proposed)

`Authorization: Bearer <agent-api-key>` carries the credential; it is never in the body.

```json
{
  "schema": "orrery.run.hook.v1",
  "event": "run_started | run_heartbeat | run_ended | child_started | child_ended",
  "runKey": { "harness": "codex", "nativeSessionId": "01a1f6bc-75fa-7ca3-8ffa-232951c1e0eb" },
  "runId": null,
  "model": "gpt-6.2-sol",
  "agentId": null,
  "agentType": null,
  "at": "2026-11-20T02:45:10.671Z"
}
```

`runKey.harness` is `codex` or `claude-code`. `runId`, `model`, `agentId` and `agentType` are
optional: `null` means the field was not reported and the UI must show `unknown`. For a child event,
`agentId` and `agentType` are taken from Codex hook `agent_id` / `agent_type` or Claude `Agent` hook
`agent_id` / `agent_type`; the parent's `nativeSessionId` is unchanged.

### Run metadata and check-in tool (proposed)

```json
{
  "name": "orrery_run_checkin",
  "arguments": {
    "runKey": {
      "harness": "codex",
      "nativeSessionId": "01a1f6bc-75fa-7ca3-8ffa-232951c1e0eb"
    },
    "runId": null,
    "checkIn": { "sequence": 21, "at": "2026-11-20T02:50:20.705Z" },
    "reported": { "model": "gpt-6.2-sol", "harnessVersion": "0.171.0" }
  }
}
```

Response shape:

```json
{
  "runId": "run_01J...",
  "accepted": true,
  "observedAt": "2026-11-20T02:50:20.725Z",
  "leaseExpiresAt": "2026-11-20T02:55:20.725Z",
  "model": "gpt-6.2-sol"
}
```

Correlation order is explicit `runId` argument, then hook-registered `(harness, nativeSessionId)`,
then `unknown`. `harnessVersion` and `model` are stored as reported and may be `unknown`. Never
derive `runId` from an MCP transport session ID or from a supplied display name.

## Verification

- No credential, API key, token, password or private transcript appears in this page or in the
  probe scripts. Header values that could carry credentials are redacted in the probe itself;
  only header names and user agents are recorded.
- The probe scripts have no authentication, listen only on `127.0.0.1` on ephemeral ports, and are
  not wired into `apps/server`. `packages/contract/src/mcp-tools.ts` declares an empty tool list;
  the production MCP app registers only feature tools. No unauthenticated probe tool is mounted on
  the production server.
- `pnpm check` passes with the scripts included. `node --test scripts/*.test.mjs` is unaffected.

## Reproducing the gate

Run each command from the repository root. Use your own provider credentials; the stub endpoint is
only for the no-credentials Claude Code case.

1. Start the probe and note its port (also written to `/tmp/orrery-harness-probe/port.txt`):

   ```sh
   node scripts/harness-compat-probe/server.ts
   ```

2. Start a client-side heartbeat in its own terminal while a CLI is blocked:

   ```sh
   node scripts/harness-compat-probe/heartbeat.ts \
     --url http://127.0.0.1:<port>/checkin/<token> \
     --interval 15000 --duration 360000 --source local-bg
   ```

3. Codex, with your own login and scratch hook configuration:

   ```sh
   codex exec --strict-config --dangerously-bypass-hook-trust \
     -c 'mcp_servers.orrery_probe.url="http://127.0.0.1:<port>/run-A/"' \
     -c 'mcp_servers.orrery_probe.default_tools_approval_mode="approve"' \
     -c 'mcp_servers.orrery_probe.tool_timeout_sec=400' \
     --enable multi_agent -C /tmp \
     "call probe_sleep(310000), then probe_poll_heartbeat('<token>')"
   ```

   Use `codex exec resume <session-id>` for the resume probe. The local path label is only a
   probe-log correlation aid; the proposed contract uses static `/mcp`.

4. Claude Code with the stub model (omit `ANTHROPIC_BASE_URL` when using real credentials):

   ```sh
   STUB_MODE=sleep-poll STUB_SLEEP_MS=310000 STUB_POLL_TOKEN=<token> \
     node scripts/harness-compat-probe/stub-model.ts
   ```

   then, in another terminal, with the stub's printed port and a local MCP config that sets
   `"timeout": 600000` for the probe server:

   ```sh
   ANTHROPIC_BASE_URL=http://127.0.0.1:<stub-port> \
   ANTHROPIC_API_KEY=local-stub-not-a-real-key \
   CLAUDE_CONFIG_DIR=/tmp/my-claude-config \
   MCP_TOOL_TIMEOUT=600000 CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0 \
   claude -p "call probe_sleep(310000), then probe_poll_heartbeat('<token>')" \
     --mcp-config /tmp/my-claude-config/mcp.json --strict-mcp-config \
     --settings /tmp/my-claude-config/hooks.json \
     --permission-mode bypassPermissions --max-turns 8
   ```

   Use `STUB_MODE=subagent` for the child probe and `claude -p --resume <session-id>` for the
   resume probe. Hook scripts belong in the local config; never commit their logs.
