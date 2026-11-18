# Orrery verification map

The maintained source for verifying Orrery's user-facing behavior. Read this index, then use the matching feature file as the recipe. Orrery is an early scaffold, so the map covers only what exists; add a file when a feature lands (`/maintain-verification-skill`).

## Baseline preconditions

- Instance started by this run with `scripts/orrery-verify.sh up` (see `../SKILL.md`), fresh database, no seed data (there is none yet).
- `scripts/orrery-verify.sh doctor $RUN_DIR` exits 0.
- Never drive an instance this run did not start (another Orrery may be on :8080).
- All commands run outside the Bash sandbox.

## Driving conventions

- Browser: `node $SK/browse.mjs $RUN_DIR <path> ...` with ARIA roles and visible text, never coordinates.
- HTTP: `curl` against `$URL` exactly as printed by `up` (host `localhost`).
- Save every artifact to `$RUN_DIR/evidence/` and name the feature ID in the file name.

## Proof and skip reporting

- UI proof: screenshot plus ARIA snapshot plus the `.json` assertions from `browse.mjs`, with zero console problems.
- HTTP proof: command, status code and body.
- Report an unreachable path with the attempted command and the unmet precondition; do not substitute another entry point.

## Features

- [Home status page](./home-status.md): the web app's `/` page showing server readiness and version, and the not-found page.
- [Health endpoints](./health.md): `/healthz` liveness and `/readyz` database readiness, including the degraded state.
- [MCP endpoint](./mcp.md): the agent connection at `/mcp`: handshake and Host-header protection.
