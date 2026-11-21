# MCP endpoint

Agents connect to Orrery over stateless Streamable HTTP at `/mcp`. The server identifies
itself as `orrery`; each request builds a fresh server and no session id is issued. A
Host/Origin allowlist derived from `PUBLIC_URL` guards against DNS rebinding by comparing
the **hostname** only. Handshake (`initialize`) and `tools/list` are unauthenticated;
every `tools/call` authenticates via an agent Bearer API key (`Authorization: Bearer <key>`).

The server registers **39 tools** (`contract/mcp-tools.json`):
- **Projects (25):** projects (2), issues (4), labels (6), dependencies (4), comments (2), links (2), activity (1), knowledge (4).
- **Runs (1):** `orrery_run_checkin`.
- **Work sessions (11):** `claim_issue`, `renew_claim`, `report_progress`, `stop_session`, `get_work_session`, `resume_work_session`, `reacquire_issue`, `ready_work`, `list_work_sessions`, `log_session_activity`, `list_session_activities`.
- **Inbox / Questions (2):** `ask_for_input`, `list_issue_questions`.

## Sub-features

- `mcp-handshake` an MCP client connects and reads server name `orrery` with `tools` capability.
- `mcp-host-guard` a request with a foreign Host header is rejected with 403.
- `mcp-tools-list` `tools/list` returns all 39 registered tool schemas.
- `mcp-tool-auth` calling a tool without a Bearer key returns `isError: true` (`not_signed_in`); calling with a valid scoped agent key succeeds.

## Driving it with the black-box suite and curl

Preconditions: healthy instance; use the `localhost` URL printed by `up`.

- **Black-box checks:** `ORRERY_URL=$URL pnpm --filter @orrery/e2e exec vitest run server.test.ts`
  (runs health, SPA fallback, and MCP handshake checks — 4 tests).
- **Raw `initialize` and `tools/list`:**
  ```bash
  curl -sS -X POST "$URL/mcp" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
  curl -sS -X POST "$URL/mcp" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    | sed -n 's/^data: //p' | jq '.result.tools | length'   # 39
  ```
- **Host guard:** POST `initialize` to `http://127.0.0.1:<port>/mcp` with `-H 'Host: evil.test'` → `403`.
- **Authenticated tool call:** call `list_projects` with `-H "Authorization: Bearer $KEY"` (from [agents](./agents.md)) and without the header to prove denial parity.

## Gotchas

- Using `127.0.0.1` instead of `localhost` in the URL makes MCP reject the request because `PUBLIC_URL`'s host is `localhost`.
- The server is stateless per request: no session id is returned.
- `tests/e2e/zz-mcp.spec.ts` covers end-to-end tool calls against the compose stack.
