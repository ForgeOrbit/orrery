# Installation invitations

An administrator invites an address; the installation emails a `/register?token=…` link
valid for seven days. Following the link changes nothing: the invitee's password POST
consumes the token and creates the account, its personal workspace, and the
verified-email mark in one transaction. Registration is invitation-only; there is no
public sign-up. The feature is API-driven for the administrator; the invitee has the
`/register` page.

## Sub-features

- `invite-guard` no session is 401 `not_signed_in`; an ordinary account is 403
  `not_admin`; a registered email is 409 `account_exists`; a duplicate pending invite is
  409 `invitation_pending`; unconfigured SMTP is 409 `smtp_unconfigured`.
- `invite-send` `POST /api/invitations/installation` returns 201
  `{email,status:"pending"}`, records `delivery_status=sent`, and Mailpit receives
  `Your Orrery invitation` with a 43-character token.
- `invite-link` `GET /register?token=…` serves the page (200 HTML); the unknown API GET
  falls through to the SPA shell (200 HTML). Neither redeems the token.
- `invite-register` `POST /api/invitations/installation/registration` returns 200
  `{email,emailVerified:true}`; the account can sign in and has one `Personal` workspace.
- `invite-reuse` the same token answers 400 `invitation_invalid`; an invented token
  answers the same.
- `invite-browser` the `/register` form (Password, then Register) signs the invitee in
  and shows the workspace list.

## Preconditions

- An administrator created by [accounts](./accounts.md) and signed in; keep the session
  cookie in a jar under `$RUN_DIR`.
- SMTP configured and reachable. Start the catcher and use its printed SMTP port:

  ```bash
  $SK/mailpit.sh up $RUN_DIR     # prints MAILPIT_SMTP and MAILPIT_HTTP
  ```

  Then `PUT /api/settings/smtp` with host `127.0.0.1`, port `$MAILPIT_SMTP`,
  `security:"none"`, no credentials, and a `from` address (see
  [settings](./settings.md)). `ORRERY_ENCRYPTION_KEY` is not needed for an open catcher
  with no password.

## Recipe

```bash
J='content-type: application/json'
I='newcomer@orrery.test'; IP='invited-newcomer-password'
curl -sS -c $RUN_DIR/admin.jar -X POST $URL/api/auth/login -H "$J" \
  -d '{"email":"admin@orrery.test","password":"browser-checked-admin-password"}'
curl -sS -b $RUN_DIR/admin.jar -X PUT $URL/api/settings/smtp -H "$J" \
  -d "{\"host\":\"127.0.0.1\",\"port\":$MAILPIT_SMTP,\"security\":\"none\",\"username\":null,\"password\":null,\"from\":\"orrery@orrery.test\"}"
curl -sS -b $RUN_DIR/admin.jar -X POST $URL/api/invitations/installation -H "$J" \
  -d "{\"email\":\"$I\"}"                                  # 201 pending
curl -sS -b $RUN_DIR/admin.jar -X POST $URL/api/invitations/installation -H "$J" \
  -d "{\"email\":\"$I\"}"                                  # 409 invitation_pending
curl -sS -b $RUN_DIR/admin.jar -X POST $URL/api/invitations/installation -H "$J" \
  -d '{"email":"admin@orrery.test"}'                       # 409 account_exists

# The token exists only in the email. Take the newest message for this recipient.
ID=$(curl -sS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages" \
  | jq -r --arg to "$I" '[.messages[] | select(.Subject=="Your Orrery invitation" and .To[0].Address==$to)] | max_by(.Created) | .ID')
TOKEN=$(curl -sS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/message/$ID" \
  | jq -r .Text | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)

# The link and the API GET are inert.
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$URL/register?token=$TOKEN"
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$URL/api/invitations/installation/registration"

# The database holds the hash, never the token.
CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
docker exec $CONTAINER psql -U orrery -d orrery -Atc \
  "select status, delivery_status, token_hash = '$TOKEN' from invitations where email='$I'"

# Register, then prove reuse fails.
curl -sS -X POST $URL/api/invitations/installation/registration -H "$J" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"$IP\"}"          # 200 emailVerified true
curl -sS -X POST $URL/api/invitations/installation/registration -H "$J" \
  -d "{\"token\":\"$TOKEN\",\"password\":\"$IP\"}"          # 400 invitation_invalid

# The new account signs in, verified, with one personal workspace.
curl -sS -c $RUN_DIR/newcomer.jar -X POST $URL/api/auth/login -H "$J" \
  -d "{\"email\":\"$I\",\"password\":\"$IP\"}"
curl -sS -b $RUN_DIR/newcomer.jar $URL/api/auth/session     # emailVerified true
curl -sS -b $RUN_DIR/newcomer.jar $URL/api/workspaces       # one Personal
```

- Browser registration: invite a second address, fetch its token with the same
  recipient filter plus `max_by(.Created)`, then

  ```bash
  node $SK/browse.mjs $RUN_DIR "/register?token=$TOKEN" --slug register-success \
    --fill "Password=browser-checked-invitee-password" --click-button Register \
    --expect-text "Signed in as browser.person@orrery.test." \
    --expect-role "heading:Your workspaces" --expect-text "Personal"
  ```

  Redact the consumed token from the evidence afterwards:
  `sed -i "s/$TOKEN/<consumed-token>/g" $RUN_DIR/evidence/register-success.*`.

- Side effects: the invitation becomes `accepted` with `delivery_status=sent`; the human
  is verified and owns one `Personal` workspace; `humans` and `workspaces` each grew by
  one. The token and the password never appear in `$RUN_DIR/server.log`.

## Gotchas

- The committed `tests/e2e/invitations.spec.ts` hardcodes SMTP host `mailpit` and the
  Mailpit API at `:8025`, so it does not run unmodified against the host-run instance.
  Use the recipe above, or the compose stack.
- The token is a secret. Keep it out of evidence after the drive, and never put it in
  `server.log`.
- Expiry is lazy: rows stay `pending` past `expires_at` until superseded. There is no
  revoke, decline, or admin invitation list yet.
- One pending invitation per email; re-inviting a valid, sent invitation is 409, not a
  rotation. An expired, failed, or long-undelivered row is superseded in place.
- `security:"none"` refuses SMTP credentials. An open Mailpit needs none.
- Delivery is separate from lifecycle: `delivery_status` is `sent`, `failed`, or null
  (unknown). Only a recorded failure never redeems; holding the token proves delivery.
