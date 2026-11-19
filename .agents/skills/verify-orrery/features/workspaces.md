# Workspaces

A signed-in human sees a `Your workspaces` section on the home page listing their own
personal workspace, named `Personal`. The REST API exposes only `GET /api/workspaces`,
scoped to the caller's personal ownership; there is no administrator bypass. Setup and
invited registration create the human and their personal workspace in one transaction.
Shared workspaces, creation, rename, delete, switching, and member management are
deferred (#24).

## Sub-features

- `workspace-list` the signed-in home shows the heading and exactly the caller's
  workspace(s); `GET /api/workspaces` returns a contract-valid array.
- `workspace-provisioning` setup and invited registration create one human plus one
  personal workspace atomically, enforced by a unique index.
- `workspace-isolation` each account sees only its own; even the system administrator's
  listing never contains another person's workspace.
- `workspace-unauth` a signed-out request is 401 `application/problem+json`, code
  `not_signed_in`.
- `workspace-browser` signing in as an invited person shows their own workspace in the
  UI.

## Preconditions

- A fresh instance with `BOOTSTRAP_SECRET`; an administrator created at `/setup`.
- A second account needs an installation invitation and Mailpit (see
  [invitations](./invitations.md)); there is no public sign-up.

## Recipe

1. Create the administrator and sign in (`admin.jar`), then invite and register a second
   person (`newcomer.jar`), as in the accounts and invitations recipes.
2. List over HTTP and compare by id, not by wording:

   ```bash
   curl -sS -b $RUN_DIR/admin.jar $URL/api/workspaces
   curl -sS -b $RUN_DIR/newcomer.jar $URL/api/workspaces
   ```

   Each returns exactly one item: `{id, kind:"personal", name:"Personal"}`. The ids
   differ, and neither listing contains the other's id.

3. Signed out:

   ```bash
   curl -sS -o $RUN_DIR/evidence/workspace-anonymous.json \
     -w '%{http_code} %{content_type}\n' $URL/api/workspaces
   # 401 application/problem+json
   cat $RUN_DIR/evidence/workspace-anonymous.json   # code not_signed_in
   ```

4. Browser proof as the invited person (the 401 is the session check on `/signin`):

   ```bash
   node $SK/browse.mjs $RUN_DIR /signin --allow-http 401 --slug workspace-newcomer \
     --fill "Email=newcomer@orrery.test" --fill "Password=invited-newcomer-password" \
     --click-button "Sign in" --expect-text "Signed in as newcomer@orrery.test." \
     --expect-role "heading:Your workspaces" --expect-text "Personal"
   ```

5. Database join: one row per human, owner matches, all `personal`:

   ```bash
   CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select h.email, w.kind, w.name from humans h join workspaces w on w.personal_owner_human_id = h.id order by h.email"
   ```

## Gotchas

- Ordering is `createdAt` only; equal timestamps make the order unstable.
- The query ignores `kind`; a future shared workspace with a null personal owner will
  never appear here. That is expected until #24.
- The administrator has no cross-account visibility by design; do not report it as a
  bug.
- The web query maps 401 to an empty array, so the UI cannot distinguish signed-out
  from workspace-less; the HTTP proof carries that distinction.
- A directly inserted human without a workspace yields `200 []`, not 401.
