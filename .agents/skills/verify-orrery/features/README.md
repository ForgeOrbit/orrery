# Orrery verification map

The maintained source for verifying Orrery's user-facing behavior. Read this index, then use the matching feature file as the recipe. Orrery is an early scaffold, so the map covers only what exists; add a file when a feature lands (`/maintain-verification-skill`).

## Baseline preconditions

- Instance started by this run with `scripts/orrery-verify.sh up` (see `../SKILL.md`), fresh database, no seed data (there is none yet).
- For `/setup`, `BOOTSTRAP_SECRET` (at least 32 characters) was set on the `up` command. For a stored SMTP password, `ORRERY_ENCRYPTION_KEY` was set too.
- For the mail features (settings, invitations), `scripts/mailpit.sh up $RUN_DIR` started the catcher; use the printed `MAILPIT_SMTP` and `MAILPIT_HTTP`.
- `scripts/orrery-verify.sh doctor $RUN_DIR` exits 0.
- Never drive an instance this run did not start (another Orrery may be on :8080).
- All commands run outside the Bash sandbox.

## Driving conventions

- Start every recipe from `SK=.agents/skills/verify-orrery/scripts`, `. $RUN_DIR/env` (sets `URL` and `CONTAINER`), and for mail features `. $RUN_DIR/mailpit.env` (sets `MAILPIT_SMTP` and `MAILPIT_HTTP`).
- Browser: `node $SK/browse.mjs $RUN_DIR <path> ...` with ARIA roles and visible text, never coordinates. Forms: `--fill "Label=value"` then `--click-button "Name"`. Expected failures: `--allow-http 401` (signed-out pages), `--allow-http 500 --allow-http 503 --allow-console ZodError` (the database-down reload). Name evidence with `--slug`.
- HTTP: `curl` against `$URL` exactly as printed by `up` (host `localhost`).
- Mail: read caught messages at `http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages`; SMTP settings point at `127.0.0.1:$MAILPIT_SMTP`.
- Save every artifact to `$RUN_DIR/evidence/` and name the feature ID in the file name.

## Proof and skip reporting

- UI proof: screenshot plus ARIA snapshot plus the `.json` assertions from `browse.mjs`, with zero unallowed console problems.
- HTTP proof: command, status code and body.
- Report an unreachable path with the attempted command and the unmet precondition; do not substitute another entry point. Restart persistence is the known case: it needs `ORRERY_RESTART_CMD` and the compose stack, not this harness.

## Features

- [Bootstrap and sign-in](./accounts.md): creating the first administrator at `/setup`
  with the deployment secret, first sign-in, the session route, and setup staying closed.
- [Home status page](./home-status.md): `/` in its fresh, signed-out, signed-in and
  database-down states, the workspace list, navigation, and the not-found page.
- [Health endpoints](./health.md): `/healthz` liveness and `/readyz` database readiness,
  including the degraded state and recovery.
- [MCP endpoint](./mcp.md): the agent connection at `/mcp`: handshake, Host-header
  protection, and the empty tool list.
- [Installation invitations](./invitations.md): an administrator invites an address,
  Mailpit catches the link, the invitee registers through `/register` and gets a
  personal workspace, and the token is single-use.
- [SMTP settings and email verification](./settings.md): an administrator saves the
  installation's SMTP relay, sends a test email, verifies their address with the
  token, and repairs a broken relay.
- [Workspaces](./workspaces.md): the signed-in home lists the caller's personal
  workspace, and each person sees only their own.
