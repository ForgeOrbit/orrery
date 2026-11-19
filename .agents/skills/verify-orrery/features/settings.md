# SMTP settings and email verification

The settings feature is API-only today: a system administrator saves one
installation-wide SMTP configuration, sends a test email to their own address, and
redeems the single-use token in that email to mark the address verified. The SMTP
password is never returned; it is encrypted at rest with `ORRERY_ENCRYPTION_KEY`
(ADR-0004). This feature owns the only mail transport; invitations borrow it.

## Sub-features

- `smtp-guard` `GET`, `PUT`, and `POST /smtp/test` are 401 `not_signed_in` without a
  session and 403 `not_admin` for an ordinary account. `POST /email-verification` needs
  a session but not an administrator: a random token from an ordinary account answers
  400 `verification_token_invalid`, because the token must belong to that account.
- `smtp-save` `PUT /api/settings/smtp` replaces the whole configuration; `GET` returns
  `{host,port,security,username,hasPassword,from}` with nulls before configuration.
  `security:"none"` with credentials is 400 `insecure_smtp_credentials`; a password
  without a key is 409 `encryption_key_missing`.
- `smtp-echo` responses expose only `hasPassword`; the database holds `v1:…`, never the
  plaintext; logs never carry it.
- `smtp-test` `POST /api/settings/smtp/test` answers 200 `{sentTo}` and Mailpit receives
  `Verify your Orrery email` with a 43-character token on its own line.
- `email-verify` `POST /api/settings/email-verification` returns
  `{email,emailVerified:true}` once; reuse is 400 `verification_token_invalid`; the
  session reflects the verified flag.
- `smtp-repair` a broken relay answers 502 `smtp_unreachable` (a Problem); sign-in still
  works; saving a working relay again and resending answers 200.

## Preconditions

- An administrator created by [accounts](./accounts.md) and signed in; keep the session
  cookie in a jar under `$RUN_DIR`.
- `ORRERY_ENCRYPTION_KEY` (canonical base64 of 32 bytes) set on the `up` command when
  testing a stored password. Without it, saving a password is 409.
- The catcher: `$SK/mailpit.sh up $RUN_DIR` prints `MAILPIT_SMTP` and `MAILPIT_HTTP`.
- The administrator starts with `emailVerified:false`; verification is a state flag, not
  an authorization requirement.

## Recipe

```bash
J='content-type: application/json'; C=$RUN_DIR/admin.jar
curl -sS -c "$C" -X POST $URL/api/auth/login -H "$J" \
  -d '{"email":"admin@orrery.test","password":"browser-checked-admin-password"}'
curl -sS -b "$C" $URL/api/settings/smtp          # nulls on a fresh instance; configured after invitations

# A password-bearing shape: tls may carry credentials, and it never sends.
curl -sS -b "$C" -X PUT $URL/api/settings/smtp -H "$J" \
  -d "{\"host\":\"127.0.0.1\",\"port\":$MAILPIT_SMTP,\"security\":\"tls\",\"username\":\"postmaster\",\"password\":\"relay-needle-passphrase\",\"from\":\"orrery@orrery.test\"}"
# Response has hasPassword true and no plaintext.
CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
docker exec $CONTAINER psql -U orrery -d orrery -Atc \
  "select left(smtp_password_encrypted,3), position('relay-needle' in coalesce(smtp_password_encrypted,'')) from instance_settings"
# v1|0

# The working relay: plain, no credentials.
curl -sS -b "$C" -X PUT $URL/api/settings/smtp -H "$J" \
  -d "{\"host\":\"127.0.0.1\",\"port\":$MAILPIT_SMTP,\"security\":\"none\",\"username\":null,\"password\":null,\"from\":\"orrery@orrery.test\"}"
curl -sS -b "$C" -X POST $URL/api/settings/smtp/test        # 200 sentTo

# Fetch the newest token from the catcher, redeem it once, then fail to reuse it.
ID=$(curl -sS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages" \
  | jq -r '[.messages[] | select(.Subject=="Verify your Orrery email")] | max_by(.Created) | .ID')
TOKEN=$(curl -sS "http://127.0.0.1:$MAILPIT_HTTP/api/v1/message/$ID" \
  | jq -r .Text | sed -n '/Single-use token, valid for 24 hours:/{n;n;p;}' | tr -d '\r')
curl -sS -b "$C" $URL/api/auth/session                      # emailVerified false
curl -sS -b "$C" -X POST $URL/api/settings/email-verification -H "$J" \
  -d "{\"token\":\"$TOKEN\"}"                               # 200 true
curl -sS -b "$C" -X POST $URL/api/settings/email-verification -H "$J" \
  -d "{\"token\":\"$TOKEN\"}"                               # 400 verification_token_invalid

# Break the relay, see the actionable Problem, prove sign-in still works, repair.
curl -sS -b "$C" -X PUT $URL/api/settings/smtp -H "$J" \
  -d '{"host":"127.0.0.1","port":1,"security":"none","username":null,"password":null,"from":"orrery@orrery.test"}'
curl -sS -b "$C" -X POST $URL/api/settings/smtp/test        # 502 smtp_unreachable
curl -sS -o /dev/null -w '%{http_code}\n' -X POST $URL/api/auth/login -H "$J" \
  -d '{"email":"admin@orrery.test","password":"browser-checked-admin-password"}'   # 200
```

- Anonymous guards need **valid** bodies, or validation answers 400 before the session
  check: `PUT` with a complete settings object, `POST test` with no body, `POST verify`
  with `{"token":"x"}`. Each then answers 401 `not_signed_in`.
- Non-administrator guards: sign in as an invited account (see
  [invitations](./invitations.md)) and repeat `GET`/`PUT`/test; each answers 403
  `not_admin`. The verification route is the exception: with a random token it answers
  400 `verification_token_invalid`, not 403, because it authorizes the token's owner
  rather than an administrator.
- Side effects: `email_verification_tokens.used_at` is set once, and
  `humans.email_verified_at` is set for the administrator. The password, token, and
  encryption key never appear in `$RUN_DIR/server.log`.

## Gotchas

- `PUT` is replace-all: omitting `password` clears the stored one. The response never
  echoes it.
- `security:"none"` refuses credentials by design; use `tls` or `starttls` for the
  echo/encryption check. The tls shape above is stored but never sent.
- A new test email invalidates earlier unused tokens; a failed send deletes its token.
- Only SHA-256 token hashes are stored. A missing or rotated key makes a stored password
  unreadable (409 `smtp_password_unreadable`); re-enter it.
- There is no settings web UI; drive the API.
- Restart persistence is not covered by this harness. The committed `smtp.spec.ts`
  covers it when `ORRERY_RESTART_CMD` is set, against the compose stack.
