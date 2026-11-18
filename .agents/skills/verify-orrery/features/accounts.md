# Bootstrap and sign-in (accounts)

The first system administrator is created through the browser at `/setup`, protected by
the deployment's `BOOTSTRAP_SECRET`, and setup closes forever in the same transaction
(issue #21). Sign-in at `/signin` sets an HttpOnly session cookie.

## Preconditions

- A fresh instance started by this run **with a bootstrap secret** (the secret reaches the
  server through the environment; unset means setup is closed):

  ```bash
  BOOTSTRAP_SECRET=verify-secret $SK/orrery-verify.sh up
  ```

- `scripts/orrery-verify.sh doctor $RUN_DIR` exits 0.

## Recipe

- Home points the installer the right way:
  `node $SK/browse.mjs $RUN_DIR / --expect-role link:"Set up Orrery"`.
- Refusal: a wrong secret cannot create the administrator, and a bare GET changes
  nothing — `curl -i $URL/api/setup/admin` is refused (405/400), and
  `curl $URL/api/setup/status` still reports `{"setupComplete":false}` afterwards.
- The committed Playwright specs drive the real forms (browse.mjs cannot fill forms, so
  reuse the spec against this instance — it is the same black-box flow CI runs):

  ```bash
  ORRERY_URL=$URL ORRERY_SETUP_SECRET=verify-secret \
    pnpm --filter @orrery/e2e exec playwright test bootstrap.spec.ts -g "creates the first"
  ```

  After it passes, `/setup` redirects to `/signin`, and
  `curl $URL/api/setup/status` reports `{"setupComplete":true}`.
- Side effects in the database (one human, one personal workspace, one setup row):

  ```bash
  docker exec $CONTAINER psql -U orrery -d orrery -c \
    "select (select count(*) from humans) humans, (select count(*) from workspaces) workspaces, (select count(*) from instance_setup) setup"
  ```

- Logs never carry the secret, the password, or the session token: after driving the
  flow, `grep -c "$SECRET" $RUN_DIR/server.log` returns 0 (same for the password).

## After a restart

`kill -TERM $(cat $RUN_DIR/server.pid)` is not the deployed path; restart the recorded
process or reuse `ORRERY_RESTART_CMD` with the e2e suite's restart test. Setup must stay
closed (`{"setupComplete":true}`) and `/signin` must still work.
