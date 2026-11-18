# MCP endpoint

Agents connect to Orrery over Streamable HTTP at `/mcp`. The server identifies itself as `orrery`, and only accepts requests whose Host (and Origin, when sent) match `PUBLIC_URL`. No tools are registered yet; when features add some, list them here.

## Sub-features

- `mcp-handshake` an MCP client connects and reads server name `orrery`.
- `mcp-host-guard` a request with a foreign Host header is rejected with 403.

## How to get to it (user POV)

- Point an MCP client (Streamable HTTP) at `$URL/mcp`.

## Driving it with the e2e suite and curl

Preconditions: healthy instance; use the `localhost` URL printed by `up`.

- **Handshake.** `ORRERY_URL=$URL pnpm test:e2e 2>&1 | tee $RUN_DIR/evidence/mcp-e2e.txt`. The `mcp` test and the health and web-app tests pass (4 tests).
- **Raw request.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'` prints `200`.
- **Host guard.** The same request to `http://127.0.0.1:<port>/mcp` with `-H 'Host: evil.test'` prints `403`.
- **Tools (when they exist).** Connect with `@modelcontextprotocol/client` as in `tests/e2e/server.test.ts`, call `listTools`, then call a tool and check the database with `docker exec $CONTAINER psql -U orrery -d orrery -c '<query>'`.

## Gotchas

- Run `pnpm test:e2e` from the repo root.
- Using `127.0.0.1` instead of `localhost` in the URL makes MCP reject the request, because `PUBLIC_URL` host is `localhost`.
- The server is stateless per request: no session id is returned.
