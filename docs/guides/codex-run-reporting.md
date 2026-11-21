# Codex CLI run reporting

Codex CLI can report its runs to Orrery through a local hook. The hook maps Codex's native
lifecycle events onto the run-reporting contract shipped in
[issue #34](https://github.com/forge-orbit/orrery/issues/34), using the mechanism the
[harness compatibility proof](https://github.com/forge-orbit/orrery/issues/29) found reliable.
It is part of the [agent integration proof](https://github.com/forge-orbit/orrery/issues/20)
and the Codex slice of [issue #45](https://github.com/forge-orbit/orrery/issues/45).

> The issue text calls the endpoint `POST /api/runs/report`. The route actually shipped in #34
> is **`POST /api/runs/hook`**; that is the endpoint the hook uses.

The hook is a standalone script: [`scripts/codex-run-hook.mjs`](../../scripts/codex-run-hook.mjs).
It does not import server code, is not mounted on the Orrery server, and adds no schema
migration. It never opens a port; it only POSTs to Orrery.

## Tested version

| Harness | Version exercised | Credentials | Model reported by the hook |
| --- | --- | --- | --- |
| Codex CLI | `codex-cli 0.171.0` | Live ChatGPT sign-in on the test host | the active model slug from each hook payload |

The CLI version is not present in a Codex hook payload, so it is supplied as an environment
variable (`ORRERY_CODEX_VERSION`). If you omit it, the version is stored as `unknown`, exactly
like any other missing field.

## What gets reported

| Codex hook event | Orrery event | Effect |
| --- | --- | --- |
| `SessionStart` (`startup` or `resume`) | `run_started` | Creates the run, or reactivates it after a resume. |
| `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, model/compact events | `run_heartbeat` | A point-in-time observation; refreshes the last-heartbeat time. It is **not** a claim lease. |
| `SubagentStart` | `child_started` | Creates a child row via `agent_id` / `agent_type`. |
| `SubagentStop` | `child_ended` | Ends that child row. |
| `SessionEnd` | `run_ended` | Ends the run. |

Every event carries the stable key `(harness: "codex", nativeSessionId: Codex session_id)`.
A child reports on the **parent** session id with child attribution in `agent_id` /
`agent_type`, so a subagent appears under its parent run. A resumed conversation reuses the
same native session id, so it reuses the run. Two concurrent conversations have different
session ids and therefore stay distinct. A model change is recorded in the run's history.

Absent `model`, `harnessVersion`, `agentId` or `agentType` are sent as `null`, stored as `null`,
and displayed as `unknown`. No value is inferred from an agent's display name or from an MCP
transport session.

## Setup

### Recommended: install the Codex plugin

The easiest way to wire both the lifecycle hooks and static `/mcp` endpoint is the installable
plugin from [`forge-orbit/orrery-integrations`](https://github.com/forge-orbit/orrery-integrations):

1. Create an agent in Orrery, issue it a workspace-scoped API key, and export `ORRERY_URL` and
   `ORRERY_API_KEY` (or `ORRERY_API_KEY_FILE`) in the environment Codex inherits:

   ```sh
   export ORRERY_URL="https://orrery.example.com"
   export ORRERY_API_KEY="<the agent API key secret>"
   # or: export ORRERY_API_KEY_FILE=/path/to/secret-file
   ```

2. Add `forge-orbit/orrery-integrations` as a Codex plugin marketplace
   (`.agents/plugins/marketplace.json`), install `orrery` from `/plugins`, and open `/hooks` to
   review and trust its lifecycle hooks.

### Manual setup (from this checkout)

If you prefer to point directly at `scripts/codex-run-hook.mjs` in this repository instead of
installing the plugin:

#### 1. Create an agent key

Create an agent in Orrery and issue it an API key for the workspace whose runs you want to
see. Copy the one-time secret into your secret manager or shell environment — it is shown only
once. The bearer key identifies the agent and scopes the workspace; it never goes in the hook
body, a log line, or a committed file.

#### 2. Install the hook

Point Codex at the committed script. A user-level `hooks.json` (`$CODEX_HOME/hooks.json`,
normally `~/.codex/hooks.json`) that watches the lifecycle looks like this:

```json
{
  "description": "Report Codex runs to Orrery",
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/codex-run-hook.mjs" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/codex-run-hook.mjs" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/codex-run-hook.mjs" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/codex-run-hook.mjs" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/codex-run-hook.mjs" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/codex-run-hook.mjs" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/orrery/scripts/codex-run-hook.mjs" }] }]
  }
}
```

Use an absolute path to the script (resolve it from the git root if you check Orrery out in
different places). `SubagentStart` / `SubagentStop` require multi-agent support
(`--enable multi_agent`). You can declare the same hooks inline under `[hooks]` in
`config.toml` instead; use one format per layer, not both.

Non-managed hooks must be reviewed and trusted. In the interactive CLI, open `/hooks` to review
and trust them. For automation that already vets its hook sources, pass
`--dangerously-bypass-hook-trust` on the `codex exec` command.

#### 3. Supply configuration to the hook

Export these in the environment that launches `codex`:

| Variable | Meaning |
| --- | --- |
| `ORRERY_URL` | Base URL of the Orrery server (default `http://localhost:8080`). |
| `ORRERY_AGENT_KEY` | The agent API key secret. Preferred for ephemeral shells. |
| `ORRERY_AGENT_KEY_FILE` | Path to a local file holding the key, read at hook time. Use instead of the inline variable when you keep the key in a secret file. |
| `ORRERY_CODEX_VERSION` | Optional CLI version to record; omitted means `unknown`. |
| `ORRERY_HOOK_TIMEOUT_MS` | Optional POST timeout in milliseconds (default `3000`). |

The key is read at run time from the environment or that local file. Never write it into
`hooks.json`, `config.toml`, the repository, or a committed log. Keep the secret file outside
the worktree and restrict its permissions.

#### 4. Configure the static MCP endpoint

The same agent key authenticates the agent's normal work through one static MCP URL. In
`$CODEX_HOME/config.toml`:

```toml
[mcp_servers.orrery]
url = "http://localhost:8080/mcp"
bearer_token_env_var = "ORRERY_AGENT_KEY"
default_tools_approval_mode = "approve"
```

Two concurrent terminals share this URL; the bearer key identifies the agent, while the hooks
distinguish the runs. `orrery_run_checkin` is available for explicit check-ins when a hook is
not installed, but it is additive — the agent still works through static `/mcp` without it.

## Failure behaviour

The hook is advisory. It always exits `0`, writes nothing to stdout, and swallows parse,
network, and timeout errors, so a reporting failure cannot interrupt a Codex conversation.
Optional diagnostics go to `stderr` only when `ORRERY_HOOK_DEBUG` is set, and are redacted
before being written; set `ORRERY_HOOK_TRACE` to a local path to capture redacted JSON lines for
troubleshooting. Transcripts are never read or forwarded.

## Live gate (2026-11-20)

Run against an isolated Orrery instance on an OS-assigned ephemeral HTTP port, with a uniquely
named loopback Postgres container from the repository's `verify-orrery` harness. Port 8080 was
not used. The server ran this source tree on base commit `9e6f616` plus this change. The Codex
CLI used live ChatGPT credentials and real model calls. Evidence stayed under `/tmp`; it is not
committed.

| Scenario | How it was driven | Result |
| --- | --- | --- |
| Concurrent conversations | Two `codex exec` processes started together with distinct prompts, sharing one agent key and one static `/mcp` URL. | Two distinct runs, both `harness: codex`, `harnessVersion: 0.171.0`, `model: gpt-6.2-sol`, each with its own native session id. |
| Spawned subagent | A third `codex exec --enable multi_agent` run asked the model to `spawn_agent` a `default` child and wait for it. | `SubagentStart` / `SubagentStop` reported `agent_id` and `agent_type: default` on the parent session id. The parent run shows one child worker with `status: ended`. |
| Resumed conversation | `codex exec resume <session-id>` on the first conversation. | The same session id produced a fresh `run_started` / `run_ended`; no new run was created. |
| Static `/mcp` | `config.toml` set `bearer_token_env_var = "ORRERY_AGENT_KEY"`; a real Codex run called `orrery_run_checkin`. | The tool returned a `runId`, and that run persisted. The black-box MCP smoke suite passed 4/4. |
| Missing fields | A hook POST with no `model` or `harnessVersion`, and an MCP check-in with no reported metadata. | Both fields persisted as `null` and are displayed as `unknown`; no value was invented. |

Verification was through `GET /api/workspaces/{workspaceId}/runs` with an authenticated human
session: six runs total (three real Codex conversations, the MCP check-in conversation, its
explicit check-in key, and the missing-fields probe), with exactly one child worker on the
subagent conversation's parent run. No credential or private transcript appeared in the agent
key file's surroundings, the server log, hook trace, or evidence: the harness POSTs only the
mapped metadata, and the bearer key was checked against every log and committed file.

The hook's unit tests cover the same mapping without a live server (start, heartbeat, end,
child attribution, missing fields, redaction, and non-blocking failure). `pnpm check` passes,
and `node --test scripts/*.test.mjs` passes all 17 tests.
