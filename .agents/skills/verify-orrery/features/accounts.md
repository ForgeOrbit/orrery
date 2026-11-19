# Bootstrap and sign-in (accounts)

The first system administrator is created through the browser at `/setup`, protected by
the deployment's `BOOTSTRAP_SECRET`, and setup closes forever in the same transaction
(issue #21). Sign-in at `/signin` sets an HttpOnly session cookie; `/api/auth/session`
resolves it. Invited humans enter through `/register` (see [invitations](./invitations.md)).

## Sub-features

- `setup-status` `GET /api/setup/status` returns `{"setupComplete":false}` then `true`.
- `setup-open` `/setup` renders the form while setup is open; home links `Set up Orrery`.
- `setup-refuse` a wrong secret answers 401 `invalid_secret` and changes nothing.
- `setup-create` the correct secret answers 201 and creates the administrator, their
  personal workspace, and the setup row in one transaction; a second POST answers 409
  `setup_complete`.
- `setup-closed` after completion `/setup` redirects to `/signin`; the setup POST is
  refused even with the correct secret.
- `setup-unavailable` with no `BOOTSTRAP_SECRET`, the POST answers 403
  `setup_unavailable`; `/setup` still renders and home still links it.
- `signin` the `/signin` form posts to `/api/auth/login`; success sets the HttpOnly
  `orrery_session` cookie and home shows `Signed in as <email>.`; wrong credentials
  answer 401 `invalid_credentials`.
- `session` `GET /api/auth/session` returns `{email,emailVerified}` or 401
  `not_signed_in`.

## Preconditions

- A fresh instance started by this run **with a bootstrap secret** (at least 32
  characters; the secret reaches the server through the environment):

  ```bash
  SECRET=verify-orrery-bootstrap-secret-0123456789
  BOOTSTRAP_SECRET=$SECRET $SK/orrery-verify.sh up
  ```

- `scripts/orrery-verify.sh doctor $RUN_DIR` exits 0.
- No accounts exist yet (setup must be open).

## Recipe

- Status and refusal. `curl -sS $URL/api/setup/status` reports `{"setupComplete":false}`.
  A wrong-secret POST answers 401 `invalid_secret`; a bare `GET /api/setup/admin` is not
  an endpoint — with `WEB_DIST` the SPA fallback answers 200 HTML, not 405/400:

  ```bash
  curl -sS -X POST $URL/api/setup/admin -H 'content-type: application/json' \
    -d '{"secret":"wrong","email":"admin@orrery.test","password":"browser-checked-admin-password"}'
  curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' $URL/api/setup/admin
  ```

- Setup page. `node $SK/browse.mjs $RUN_DIR /setup --slug setup-open --expect-role heading:"Set up Orrery"`.

- The committed Playwright spec drives the real forms (wrong secret, creation, first
  sign-in; its restart test skips without `ORRERY_RESTART_CMD`):

  ```bash
  ORRERY_URL=$URL ORRERY_SETUP_SECRET=$SECRET CHROMIUM_PATH=/usr/bin/chromium \
    pnpm --filter @orrery/e2e exec playwright test bootstrap.spec.ts
  ```

  Expect 2 passed, 1 skipped. After it passes, `/api/setup/status` reports
  `{"setupComplete":true}`, and a second POST answers 409 `setup_complete`.

- Home states. After setup, a browser without the cookie sees
  `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --slug home-signed-out --expect-text "Sign in to continue."`.
  Sign in through the form and see the account and workspace:

  ```bash
  node $SK/browse.mjs $RUN_DIR /signin --allow-http 401 --slug home-signed-in \
    --fill "Email=admin@orrery.test" --fill "Password=browser-checked-admin-password" \
    --click-button "Sign in" --expect-text "Signed in as admin@orrery.test." \
    --expect-role "heading:Your workspaces" --expect-text "Personal"
  ```

  `/setup` now redirects to `/signin`:
  `node $SK/browse.mjs $RUN_DIR /setup --allow-http 401 --slug setup-closed --expect-role "heading:Sign in"`.

- Side effects in the database (one human, one personal workspace, one setup row):

  ```bash
  CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
  docker exec $CONTAINER psql -U orrery -d orrery -c \
    "select (select count(*) from humans) humans, (select count(*) from workspaces) workspaces, (select count(*) from instance_setup) setup"
  ```

- Logs never carry the secret, the password, or the session token: after driving the
  flow, `! grep -qF "$SECRET" $RUN_DIR/server.log` and the same for the password both
  succeed (no match).

## Gotchas

- The home page answers 401 for `/api/auth/session` and `/api/workspaces` when signed
  out. `browse.mjs` treats those as problems unless you pass `--allow-http 401`.
- Unset `BOOTSTRAP_SECRET` closes setup but does not hide it: `/setup` still renders and
  home still links it; only the POST is refused (403 `setup_unavailable`).
- The bootstrap spec needs `ORRERY_URL`, `ORRERY_SETUP_SECRET`, and `CHROMIUM_PATH`; it
  drives the whole story (wrong secret, creation, first sign-in, second POST) in one
  black-box spec, while `browse.mjs` covers the individual pages.
- Restart persistence is not covered by this harness. The spec's restart test skips
  without `ORRERY_RESTART_CMD`, which belongs to the compose stack; see `../SKILL.md`.
- The session cookie is a secret: keep the cookie jar in `$RUN_DIR`, never in
  `evidence/`.
