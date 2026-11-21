# Claude Code run reporting

Orrery records each Claude Code CLI conversation as a **run** under the authenticated agent
identity. The wiring for [issue #44](https://github.com/forge-orbit/orrery/issues/44) uses the two
mechanisms the compatibility proof in [issue #29](https://github.com/forge-orbit/orrery/issues/29)
found reliable: a local hook for lifecycle events and one static MCP endpoint for the agent's
tools. The run model, REST hook and MCP check-in tool ship with
[issue #34](https://github.com/forge-orbit/orrery/issues/34). This work is part of the
[harness integration epic, issue #20](https://github.com/forge-orbit/orrery/issues/20).

> **Verified version:** `2.1.329 (Claude Code)`. Results are in [Verification](#verification).

## What is wired

Claude Code starts a run on `SessionStart` and reports tool use, a subagent, and the end of the
conversation through the same hook script. The hook POSTs a `orrery.run.hook.v1` event to
`/api/runs/hook`; the agent API key travels in the `Authorization` header, never in the body.

| Claude Code hook | Orrery event |
| --- | --- |
| `SessionStart`, `UserPromptSubmit` | `run_started` |
| `PreToolUse`, `PostToolUse` | `run_heartbeat` |
| `Stop`, `SessionEnd` | `run_ended` |
| Tool events with `agent_id` / `agent_type` | `child_started` |
| `SubagentStop` | `child_ended` |

A run is keyed by `(harness, nativeSessionId)`, where `harness` is `claude-code` and
`nativeSessionId` is the hook's `session_id`. The key is distinct across concurrent terminals and
stable across `claude --resume`, so a resume continues the same run instead of creating another
one. Child events keep the parent's `session_id` and add the child's `agent_id` and `agent_type`.

Claude Code 2.1.329 hooks report neither a model nor a harness version. Those fields are stored as
`null` and displayed as `unknown`; they are never guessed from an agent's display name or from an
MCP transport session. If a future hook does report a `model` field, the hook forwards it as
reported. Hooks are point-in-time observations, not a claim lease: reporting never grants or renews
a five-minute lease.

The agent also connects to the static `/mcp` endpoint with the same key, so
`orrery_run_checkin` and the project tools are available in every conversation. Both concurrent
terminals and subagents use that one URL; the key identifies the agent, not the run.

## Setup

### Recommended: install the Claude Code plugin

The easiest way to wire both the lifecycle hooks and static `/mcp` endpoint is the installable
plugin from [`forge-orbit/orrery-integrations`](https://github.com/forge-orbit/orrery-integrations):

1. Create an agent in Orrery, issue it a workspace-scoped API key, and export `ORRERY_URL` and
   `ORRERY_API_KEY` (or `ORRERY_API_KEY_FILE`) in the environment Claude Code inherits:

   ```sh
   export ORRERY_URL="https://orrery.example.com"
   export ORRERY_API_KEY="<the agent API key secret>"
   # or: export ORRERY_API_KEY_FILE=/path/to/secret-file
   ```

2. Add the marketplace and install the plugin in Claude Code:

   ```text
   /plugin marketplace add forge-orbit/orrery-integrations
   /plugin install orrery@orrery
   ```

### Manual setup (from this checkout)

If you prefer to point directly at the local script in this repository instead of installing the
plugin, repeat these steps for each agent identity that should report runs:

1. In Orrery, create an agent and issue it a workspace-scoped API key. Copy the secret into your
   shell environment, or into a file readable only by you. Never commit it.

   ```sh
   export ORRERY_API_KEY='<the agent API key secret>'
   # or: ORRERY_API_KEY_FILE=/path/to/secret-file
   ```

2. Add the static MCP server to `.mcp.json` in the repository. Use the committed
   [`mcp.example.json`](../../scripts/claude-code-mcp.example.json) as a template:

   ```json
   {
     "mcpServers": {
       "orrery": {
         "type": "http",
         "url": "https://orrery.example.com/mcp",
         "headers": { "Authorization": "Bearer ${ORRERY_API_KEY}" }
       }
     }
   }
   ```

3. Install the hook. Add the command below to every event in `.claude/settings.json`, using the
   absolute path of this checkout's
   [`claude-code-report-hook.mjs`](../../scripts/claude-code-report-hook.mjs). The committed
   [`settings.example.json`](../../scripts/claude-code-settings.example.json) lists all seven
   events. Project settings require the usual workspace trust; for a one-off run you can pass the
   same JSON with `claude --settings <file>`.

   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/claude-code-report-hook.mjs" }] }
       ]
     }
   }
   ```

4. Set `ORRERY_URL` to the Orrery base URL (for example `https://orrery.example.com`) in the
   environment Claude Code inherits, then start Claude Code normally. No wrapper is needed.

The hook is best-effort: it always exits 0, writes nothing to stdout, and uses a short timeout. If
Orrery is unreachable or the variables are unset, the conversation continues and the report is
simply lost. `ORRERY_HOOK_DEBUG=1` writes only the event name and HTTP status to stderr.

## Privacy

The hook copies an allowlist: event name, `session_id`, optional `agent_id` / `agent_type`, an
optionally reported `model`, and a timestamp. It never reads `transcript_path`, `tool_input`,
`tool_response`, `prompt` or `last_assistant_message`, so private transcripts and tool content stay
on the machine. The API key is read from the environment or a local file at hook time and sent only
in the `Authorization` header. No credential or transcript appears in committed files, and the
hook's own diagnostics contain neither.

The probe and stub scripts used for the gate in
[`scripts/harness-compat-probe/`](../../scripts/harness-compat-probe/) bind to `127.0.0.1` on
ephemeral ports, are not imported by `apps/server`, and are not mounted on the production MCP
endpoint. No unauthenticated probe tool is exposed by Orrery.

## Verification

The gate ran on 2026-11-20 against a freshly created, isolated Orrery instance (its own Postgres
container and an ephemeral server port, so it did not touch port 8080 used by parallel work). It
drove the real `claude` CLI through the local stub model from
[`stub-model.ts`](../../scripts/harness-compat-probe/stub-model.ts) and verified the persisted runs
with `GET /api/workspaces/:workspaceId/runs`.

| Check | Result |
| --- | --- |
| Tested CLI version | `2.1.329 (Claude Code)` |
| Two concurrent conversations | Two distinct runs, harness `claude-code`, distinct native session ids |
| Subagent | Child rows on the parent run with `agentId` set and `agentType` `general-purpose` |
| `claude -p --resume <session-id>` | Same native session id, same run id — no extra run |
| Missing model and harness version | `null` on the server (displayed as `unknown`) in every run |
| Hook failure tolerance | Unit-tested: unreachable Orrery still exits 0 with no stdout |
| Secret and transcript redaction | Unit-tested: key and private markers absent from the request body |

Live Claude credentials were rechecked before the gate and were **still expired** on this host.
The exact error was `Failed to authenticate: OAuth session expired and could not be refreshed`.
The gate therefore proves real CLI, hook and MCP plumbing only; the stub model makes no real model
call, and its text is not evidence about any Claude model.

Reproduce the gate with:

```sh
node scripts/claude-code-gate.mjs
```

It requires Docker, Node 26 and `claude` on `PATH`, and writes a non-secret `results.json` into a
temporary work directory that it prints at startup. Unit tests need neither:

```sh
node --test scripts/*.test.mjs
pnpm check
```

## Limitations

- Model and harness version are `unknown` on Claude Code 2.1.329 because its hooks do not report
  them. This is intentional: absence is never filled in by inference.
- A run record is an observation, not a claim or a lease. Work-session claiming remains separate.
- The gate uses a stub model endpoint; live model metadata is still outstanding and is tracked by
  [issue #44](https://github.com/forge-orbit/orrery/issues/44).
