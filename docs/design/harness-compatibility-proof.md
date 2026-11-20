# Harness compatibility proof: Claude Code and Codex

This is the bounded compatibility proof for [issue #29](https://github.com/forge-orbit/orrery/issues/29)
and its parent [spec](https://github.com/forge-orbit/orrery/issues/20). It records one local gate
run against the two harnesses we intend to support first. It is **evidence and a contract proposal**,
not a shipped feature: no run tracking is implemented by this page.

## What was tested

| Harness | Version exercised | Model provider during the probe | Result |
| --- | --- | --- | --- |
| Codex CLI | `codex-cli 0.171.0` | Real credentials; hooks reported model `gpt-6.2-sol` | All probes ran live. |
| Claude Code CLI | `2.1.329 (Claude Code)` | No subscription or valid session on this machine. The first live probe returned the exact error `Failed to authenticate: OAuth session expired and could not be refreshed`. | MCP plumbing was exercised with the real CLI against a **local stub model endpoint**. No real model call was made, so no model-behaviour claim comes from Claude Code. |

The distinction matters. Codex results below are live model-driven calls. Claude Code results prove
what the real CLI sends over MCP and to hooks; the text the model said is not evidence about a real
Claude model. #44 must repeat the gate with real Claude credentials before claiming more.

## Method

A local-only probe MCP server ran on `127.0.0.1` on an OS-assigned ephemeral port. It offered five
tools: `probe_echo` (return observed client metadata and the arguments it received),
`probe_sleep` (hold a call open), `probe_start_heartbeat`, `probe_poll_heartbeat` (non-blocking)
and `probe_wait_heartbeat` (blocking with a deadline). It logged request methods, paths, selected
header names and user agents, plus call timings. Authorization, cookie and token headers were
redacted before logging. No transcript content or model prompt was logged.

The probe existed only in an untracked scratch directory under `apps/server/.probe-local/` during
the run and was deleted before the commit. It was bound to loopback and never imported by the app.
`packages/contract/src/mcp-tools.ts` still contains an empty `tools` array, and `apps/server`
mounts no probe tool: see [Verification](#verification).

To tell concurrent conversations apart, the local harness configuration gave each CLI process a
different MCP endpoint path, for example `http://127.0.0.1:<port>/run-A/`. That path token is set
by the person or wrapper launching the CLI; it is **not** an MCP transport session ID. Orrery's
server currently uses `sessionIdGenerator: undefined`, so there is no transport session ID to rely
on, and the spec forbids using one in any protocol version.

## Handshake identity

The `initialize` request is the only MCP message that reliably names the client. With a stateless
transport, a new server instance handles each HTTP request: on `tools/call`, both
`getClientVersion()` and `getClientCapabilities()` were `null` for both CLIs. Capture handshake
metadata once and store it against the explicit run token; do not try to read it during a tool call.

| Field | Codex CLI | Claude Code CLI |
| --- | --- | --- |
| `clientInfo.name` | `codex-mcp-client` | `claude-code` |
| `clientInfo.title` | `Codex` | `Claude Code` |
| `clientInfo.version` | `0.171.0` | `2.1.329` |
| `clientInfo.description` / `websiteUrl` | absent | present (Anthropic's agentic coding tool / claude.com) |
| negotiated protocol | `2025-06-18` | `2025-11-25` |
| declared capabilities | `elicitation` (form, url) | `roots` (listChanged), `elicitation` (form, url) |
| User-Agent | `codex-mcp-client/0.171.0` | `claude-code/2.1.329 (sdk-cli)` |
| extra handshake traffic | none observed | a `server/discover` request at `2026-07-28`, then a `GET` SSE listener on the endpoint |

Harness name and version from `clientInfo` are reliable. The model is **not** in either MCP
handshake.

## Conversations, children and resume

**Concurrent conversations.** Two Codex processes ran at the same time with endpoint tokens
`/run-A/` and `/run-B/`. Their hook `session_id` values were distinct, their MCP requests
interleaved, and the per-run path token appeared on every request (initialize, notifications,
tools/list and tools/call). Two Claude Code processes behaved the same way. Both CLIs send
identical `clientInfo` for both processes, so client identity alone cannot separate concurrent
runs.

**Spawned subagent.** Codex with `--enable multi_agent` spawned a child using
`collaborationspawn_agent` and waited with `collaborationwait_agent`. The child's tool call reached
the same MCP endpoint and the same parent `session_id`; only the hook payload for that call carried
`agent_id` (`01a1f6bd-4995-7b01-aa8b-fc78992f5713`) and `agent_type` (`default`). Nothing in the
MCP request identified the child. Claude Code launched an `Agent` subagent asynchronously; its
`PostToolUse` hook reported `status: async_launched`, an `agentId` and a `resolvedModel`. In that
stub-model run the child's MCP call was not captured, so Codex is the evidence for child-to-MCP
attribution.

**Resumed conversation.** `codex exec resume <session-id>` reused the same hook `session_id` and
the same run token; a fresh `initialize` followed. `claude -p --resume <session-id>` also kept the
same hook `session_id`. A resume therefore maps onto a *new MCP handshake for the same run*, not a
new run.

## Timing, timeouts, heartbeat and polling

All timings are local, wall-clock measurements from the probe and hook logs on 2026-11-20 (UTC).

| Measurement | Result |
| --- | --- |
| Codex, `tool_timeout_sec = 400`, `probe_sleep(305000)` | Server-side call started `02:16:45.156Z`, ended `02:21:50.160Z` (**305,004 ms**). Codex reported a client elapsed time of 305,040 ms. The call exceeded five minutes and completed. |
| Hooks during that call | `PreToolUse` at `02:16:45Z` and `PostToolUse` at `02:21:50Z` only. **Hooks are point-in-time events, not a continuous heartbeat.** |
| Background heartbeat during the same call | A server-side timer beat every 10 s and logged 30 beats while the CLI was blocked. A later `probe_poll_heartbeat` returned in **30 ms** with `count: 30`. |
| Codex, non-blocking wait | `probe_wait_heartbeat(minCount: 3, timeoutMs: 30000)` returned after **3,612 ms** with `reached: true`; the following poll took **31 ms**. Short polls do not wait for the work to finish. |
| Codex, default MCP server config | A `probe_wait_heartbeat(..., timeoutMs: 120000)` returned normally after **120,077 ms** with no timeout error. In this build and transport the documented 60 s default did not fire for this call; measure rather than assume it. |
| Codex, explicit `tool_timeout_sec = 30` against `probe_sleep(90000)` | Client failed after **30.026 s** with `timed out awaiting tools/call after 30s` and sent `notifications/cancelled` at +30 s. The server-side tool still logged its end at +90 s: **client cancellation did not stop the server's work**. |
| Claude Code, stub model, default per-server MCP config, `probe_sleep(95000)` | Server-side call started `02:28:32.364Z` and ended `02:30:07.369Z` (**95,005 ms**), with no timeout error and no cancellation request. Claude Code's documented 60 s HTTP per-request timer covers time to first response byte; this probe sent its SSE response headers immediately, so that timer was satisfied. A server that buffers the whole result before sending a byte should not assume the same outcome. |

A long call can be kept alive by server progress notifications or by a separate background process
that checks in. Hooks alone cannot do it: they fire when a tool starts and stops, not while it runs.
Do not design a five-minute claim lease around hook events.

## What can be captured, and what stays unknown

| Field | Source judged reliable | When the source is missing |
| --- | --- | --- |
| Harness name and version | `clientInfo` on `initialize`, cross-checked with User-Agent | unknown |
| Agent identity | authenticated Orrery API key, never a reported name | request is unauthorized |
| Run identity | per-conversation run token supplied by the wrapper plus the CLI `session_id` from a local hook | unknown; do not fall back to MCP transport session ID |
| Model | hook `model` field (Codex reported `gpt-6.2-sol`) | unknown |
| Model changes over a run | successive hook `model` values, recorded as events | unknown |
| Parent/child | Codex hook `agent_id` / `agent_type`; Claude `Agent` hook `agentId` / `resolvedModel` | unknown |
| Transcript content | not captured; private transcripts stay on the machine | not applicable |

The model must not be inferred from an agent's display name. In one probe the model described
itself as `GPT-6` while the local hook reported `gpt-6.2-sol`; treat self-description as
unverified text, not metadata. A client-reported field that a hook cannot confirm stays `unknown`
rather than being synthesised.

## Minimal integration contract for #34, #44 and #45

This is the smallest contract the run-tracking slice needs. It deliberately avoids the full agent
panel.

1. **Run token.** The wrapper that launches a CLI sets an explicit run token on the MCP endpoint
   path, for example `/mcp/runs/<run-id>`. The token is generated per conversation, is stable
   across resumes, and is distinct for concurrent conversations. The server binds the token to a
   run row. It is not a transport session ID, and it is not an authentication credential: the
   agent API key still authenticates the request and scopes the workspace.
2. **Handshake capture.** On `initialize`, store `clientInfo.name`, `clientInfo.version` and the
   negotiated protocol version on the run. Missing values are `unknown`. Because the transport is
   stateless, store them once against the token; do not expect them on later tool calls.
3. **Run and child metadata from hooks.** A locally configured hook POSTs a small, schema-validated
   report to Orrery with the agent's API key: run id, harness `session_id`, model, and any
   `agent_id` / `agent_type` (or Claude `agentId`) for child work. Hooks are optional setup on the
   machine; when they are absent, the server keeps `unknown` and the run still works.
4. **Check-in over MCP.** For long calls, clients or their background process send short, explicit
   check-in or progress messages. A call that blocks for minutes must not be the only source of
   liveness. Five-minute claim leases and one-hour question deadlines are server policy and do not
   depend on a tool call returning.
5. **No identity from transport.** Neither the transport session ID nor a client-supplied display
   name, model string or run label establishes identity. Identity comes from the API key; run and
   child relationships come from the explicit token and the hook report; reported metadata is stored
   as reported and may be `unknown`.

Issues #34, #44 and #45 turn this contract into the MCP tool, the persisted run model and the
per-CLI wiring.

## Verification

- No credential, API key, token, password or private transcript appears in this page. Header values
  that could carry credentials were redacted in the probe itself; only header names and user agents
  were recorded.
- The probe had no authentication and listened only on `127.0.0.1` on an ephemeral port. It is not
  committed. `packages/contract/src/mcp-tools.ts` declares an empty tool list, and the MCP app in
  `apps/server/src/platform/mcp.ts` registers only feature tools. There is no unauthenticated probe
  tool on `main`.
- No server state, schema or migration changed, so the formal verification model in
  `.agents/skills/formal-verify-orrery/` needs no update for this proof.
- `pnpm check` passes after removing the scratch probe. `pnpm test --maxWorkers=2` passes all 177 tests. The default parallel `pnpm test` is unreliable on this host: Vitest worker forks are SIGKILLed by the OS under memory pressure (the failing file varies between runs), with every test that does run passing. This is a resource limit of the machine, not a change introduced by this proof.

## Reproducing the gate

The exact scratch tools are intentionally not committed. To repeat the gate, stand up a loopback MCP
server with the five probe tools above, give each CLI process its own run-token path, then:

- Codex: set `default_tools_approval_mode = "approve"` under the server table or `codex exec`
  refuses MCP calls with `MCP tool call requires approval, but approval policy is never`. Set
  `tool_timeout_sec` deliberately; use `--enable multi_agent` for the child probe and
  `codex exec resume <session-id>` for the resume probe.
- Claude Code: pass the endpoint with `--mcp-config` and `--strict-mcp-config`, and configure hooks
  with `--settings` to capture `session_id` and child metadata. Use `--resume <session-id>` for the
  resume probe. Model-driven claims require real credentials; the run recorded here used a local
  stub endpoint only.
