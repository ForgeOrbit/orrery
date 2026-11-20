# Workspace-scoped agent API keys (agents)

A human registers an agent and issues a bearer key bound to one workspace and selected
projects (issue #30). The secret is shown once; only its hash is stored. The key's
effective project level is capped by the human owner's *current* access, and a workspace
owner can revoke any key scoped to their workspace without seeing its secret.

## Sub-features

- `agents-register` `POST /api/agents` creates a human-owned agent; `GET /api/agents` lists it.
- `agents-issue` `POST /api/agents/keys` issues a key for one workspace with 7/14/30/60/90
  days or `never` (90 by default), returning the secret once. A project outside the
  workspace or one the human cannot access answers 400 `invalid_key_grant`.
- `agents-authenticate` `GET /api/agents/me` with `Authorization: Bearer <key>` resolves the
  agent identity and effective access. `workspaceId`/`projectId` query parameters make a
  cross-workspace or out-of-scope request answer 403.
- `agents-refuse` a revoked, expired, or inactive-owner key answers 401 with a stable code;
  `never` skips only the expiry check, not revocation, activity, or access checks.
- `agents-owner-revoke` `GET`/`DELETE /api/workspaces/:id/agent-keys[/:keyId]` is owner-only,
  secret-free, and scoped to that workspace; a key elsewhere answers 404 `key_not_found`.

## Preconditions

- A fresh instance started by this run **with a bootstrap secret**, plus a signed-in
  session cookie (see [accounts](./accounts.md)). `doctor $RUN_DIR` exits 0.
- A project in the workspace, created through `POST /api/workspaces/:id/projects`.

## Recipe

Bootstrap and sign in first (accounts.md), keeping the cookie in `$RUN_DIR/agents.jar`:

```bash
SECRET=verify-orrery-bootstrap-secret-0123456789
curl -sS -c $RUN_DIR/agents.jar -X POST $URL/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@orrery.test","password":"browser-checked-admin-password"}'
WS=$(curl -sS -b $RUN_DIR/agents.jar $URL/api/workspaces | jq -r '.[] | select(.kind=="personal") | .id')
PID=$(curl -sS -b $RUN_DIR/agents.jar -X POST $URL/api/workspaces/$WS/projects \
  -H 'content-type: application/json' -d '{"name":"Agent proof"}' | jq -r .id)
AGENT=$(curl -sS -b $RUN_DIR/agents.jar -X POST $URL/api/agents \
  -H 'content-type: application/json' -d '{"name":"proof-bot"}' | jq -r .id)
```

Issue a key (the JSON response is the only place the secret appears — redirect it to a
file outside `evidence/`, and never print it into an evidence artifact):

```bash
curl -sS -b $RUN_DIR/agents.jar -X POST $URL/api/agents/keys \
  -H 'content-type: application/json' \
  -d "{\"agentId\":\"$AGENT\",\"workspaceId\":\"$WS\",\"projects\":[{\"projectId\":\"$PID\",\"level\":\"manage\"}]}" \
  > $RUN_DIR/key.json
KEY=$(jq -r .secret $RUN_DIR/key.json)
jq -r '.key.validity' $RUN_DIR/key.json        # 90
```

Authenticate, prove the scope boundary, then revoke and prove the refusal:

```bash
curl -sS -H "Authorization: Bearer $KEY" $URL/api/agents/me
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" \
  "$URL/api/agents/me?workspaceId=some-other-workspace"   # 403 key_out_of_scope
KID=$(jq -r '.key.id' $RUN_DIR/key.json)
curl -sS -b $RUN_DIR/agents.jar -X DELETE $URL/api/workspaces/$WS/agent-keys/$KID -o /dev/null -w '%{http_code}\n'  # 204
curl -sS -H "Authorization: Bearer $KEY" $URL/api/agents/me   # 401 key_revoked
```

Side effects: the key row stores a hash, not the secret, and the two events carry no
secret. `token_hash` must differ from `$KEY`:

```bash
CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
docker exec $CONTAINER psql -U orrery -d orrery -c \
  "select type, actor_human_id, workspace_id from agent_key_events order by created_at"
docker exec $CONTAINER psql -U orrery -d orrery -c \
  "select validity, (token_hash = '$KEY') as secret_stored from agent_api_keys"
```

The signed-in workspace page also renders the Agents section: `node $SK/browse.mjs
$RUN_DIR /workspaces/$WS --slug agents-page --expect-role "heading:Agents"`.

## Gotchas

- `GET /api/agents/me` has no session fallback: without a bearer header it answers 401
  `invalid_key` even when a cookie is present.
- An issued key's `projects` are the *requested* levels; the identity response reports the
  effective levels after the human-access ceiling. A `manage` request by a contributor
  resolves to `contribute`.
- The compose e2e suite (`tests/e2e/zz-agents.spec.ts`) covers the two-human owner
  revocation path that this single-admin recipe cannot reach.
