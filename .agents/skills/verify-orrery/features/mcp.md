# MCP endpoint

Agents connect to Orrery over stateless Streamable HTTP at `/mcp`. The server identifies
itself as `orrery`; each request builds a fresh server and no session id is issued. A
Host/Origin allowlist derived from `PUBLIC_URL` guards against DNS rebinding: it compares
the **hostname** only, so the port does not matter. No tools are registered yet, and the
server does not advertise the tools capability.

## Sub-features

- `mcp-handshake` an MCP client connects and reads server name `orrery`.
- `mcp-host-guard` a request with a foreign Host header is rejected with 403.
- `mcp-tools-empty` `listTools` returns `{"tools":[]}` (the client notes the server does
  not advertise the capability).

## How to get to it (user POV)

- Point an MCP client (Streamable HTTP) at `$URL/mcp`.

## Driving it with the black-box suite and curl

Preconditions: healthy instance; use the `localhost` URL printed by `up`.

- **Black-box checks.** `ORRERY_URL=$URL pnpm --filter @orrery/e2e exec vitest run server.test.ts`
  runs the health, SPA fallback and MCP handshake checks (4 tests). The full
  `pnpm test:e2e` is the compose suite (vitest plus Playwright, including Mailpit) and
  is not this harness.
- **Raw initialize.** The response is an SSE `message` whose `serverInfo.name` is
  `orrery`:

  ```bash
  curl -sS -X POST $URL/mcp -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
  ```

- **Host guard.** The same request to `http://127.0.0.1:<port>/mcp` with
  `-H 'Host: evil.test'` prints `403`.
- **Tool list.** Connect with `@modelcontextprotocol/client` as in
  `tests/e2e/server.test.ts`, call `listTools`, and expect `{"tools":[]}`. When tools
  land, list them here and call one, checking the database for its side effect.

## Gotchas

- Run the black-box file from the repo root; the package is `@orrery/e2e`.
- Using `127.0.0.1` instead of `localhost` in the URL makes MCP reject the request,
  because `PUBLIC_URL`'s host is `localhost`. The Host guard compares hostnames, so a
  foreign port alone is not a rejection.
- The server is stateless per request: no session id is returned.
- The full e2e suite expects the compose stack and Mailpit; do not run it against this
  host-run instance.
