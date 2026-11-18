---
name: verify-orrery
description: Launch an isolated Orrery (Hono server + React web app + Postgres) and prove behavior by driving it the way a user or agent would — headless Chromium for the web UI, curl for REST/health, an MCP client for /mcp. Use when asked to verify, demo, screenshot or confirm that a change works in the real app, not just in unit tests.
---

# Verify Orrery

Orrery is one Node process (`apps/server`, port from `PORT`) that serves the REST API, MCP at `/mcp`, and the built web app, backed by Postgres. Today the user-facing surface is small (home status page, health endpoints, MCP handshake); read `features/README.md` for the current map and extend it when you add a feature.

## Requirements and sandbox

- Docker (for a throwaway `postgres:18`), Node 26, pnpm, `curl`, `ss`, and a Chromium (`/usr/bin/chromium`, or set `CHROMIUM_PATH`). Playwright is taken from the machine (`PLAYWRIGHT_MODULE`, default: wherever `playwright` is on `PATH`); it is not a repo dependency, and no browsers are downloaded.
- **Run every command below outside the Bash sandbox** (`dangerouslyDisableSandbox`). Docker's socket is blocked inside it, and a server started in one sandboxed command is unreachable from the next. The server and database bind loopback only.
- Other projects' containers may own ports 5432, 8080 and 8081. The helper picks random free ports and never touches them, so two runs can coexist.

## Launch

```bash
SK=.agents/skills/verify-orrery/scripts
$SK/orrery-verify.sh up        # ~10s; prints RUN_DIR=... and URL=http://localhost:<port>
```

`up` starts a uniquely named Postgres container, builds the web app into `$RUN_DIR/web-dist` (the repo's `apps/web/dist` is untouched), starts `node src/main.ts` with `WEB_DIST`, and waits until `/readyz` is ok. Migrations run at startup. Keep `RUN_DIR` and `URL`; pass `RUN_DIR` to every other command. Use the `localhost` URL as printed: MCP rejects any other Host (`PUBLIC_URL` is set to it).

The API/MCP contract changes only through code, so for a change to a route or tool also run `pnpm gen` and check `git diff contract/`.

## Doctor

```bash
$SK/orrery-verify.sh doctor $RUN_DIR
```

Read-only. Checks: server pid is ours and running, the port is owned by that pid, the Postgres container is running, `/healthz` and `/readyz` return `status: ok`, `/` serves the web app, the web build belongs to this run. Exit 0 means worth driving. Run it first whenever anything looks off; if the port is owned by another process, do not drive it.

## Drive

- **Web UI** (headless Chromium, stable handles are ARIA roles/names):
  ```bash
  node $SK/browse.mjs $RUN_DIR <path> [--click-link <name>] [--expect-role role:Name] [--expect-text "text"]
  ```
  e.g. `node $SK/browse.mjs $RUN_DIR / --expect-role heading:Orrery --expect-text "Server: ok"`. It fails (exit 1) on a missing expectation, any console error, page error, failed request or HTTP status >= 400 (so a deliberate 4xx page needs a different recipe). For anything it does not cover, write a one-off Playwright script the same way: `getByRole`/`getByText`, never coordinates.
- **REST / health**: `curl -fsS $URL/healthz`, `$URL/readyz`. New routes are listed in `contract/openapi.json`.
- **MCP**: `ORRERY_URL=$URL pnpm test:e2e` runs the black-box suite (health, SPA fallback, MCP handshake); or use an MCP client against `$URL/mcp`. For one-off tool calls use `@modelcontextprotocol/client` as in `tests/e2e/server.test.ts`.
- **Database state** (side effects of a new feature): `docker exec $CONTAINER psql -U orrery -d orrery -c '<read-only query>'`; `CONTAINER` is in `$RUN_DIR/env`.
- **Server logs**: JSON lines in `$RUN_DIR/server.log`. Check them after a drive for unexpected `error`/`warn` entries.

Per-feature recipes live in `features/`. Pick the matching file; if the change touches a feature that is not mapped, drive it by hand and add a file.

## Evidence

Everything goes to `$RUN_DIR/evidence/` (`/tmp/orrery-verify/<run>/evidence/`): `browse.mjs` writes `<slug>.png`, `<slug>.aria.txt` and `<slug>.json` (URL, status, assertion results, console problems). Save curl output and e2e output there too (`... | tee $RUN_DIR/evidence/<name>.txt`).

Standards for a proof:

- Exercise the real user path: a browser page, an HTTP request, an MCP client. Not the service layer, not a test-only endpoint.
- Capture the action and the resulting state, and verify side effects (DB rows, logs) as well as what is visible.
- No mocks. Postgres is real; there is no external system to fake yet.
- State the build under test: `git rev-parse --short HEAD`, whether the tree is dirty, and `RUN_DIR`. Note `version` in `/healthz` is `dev` for a source run, so it does not identify the commit.

## Cleanup

```bash
$SK/orrery-verify.sh down $RUN_DIR
```

Stops only the recorded server pid (after checking it is still our `src/main.ts`), force-removes the run's container and its volume, and deletes `$RUN_DIR/web-dist`. It never kills by name and keeps `$RUN_DIR/evidence`, `server.log` and `env`. Run `down` after every attempt, including failed ones. Confirm with `docker ps -a --filter name=orrery-verify-` and `ls $RUN_DIR/evidence`.
