# History and account deactivation

Orrery exposes three scoped, human-session-only audit feeds plus system-administrator account deactivation and reactivation:
- **History**: `GET /api/installation/history` (`/history/installation`, system admin only, installation events only), `GET /api/workspaces/{workspaceId}/history` (`/history/workspace/$workspaceId`, owners and permission managers within scope), and `GET /api/projects/{projectId}/history` (`/history/project/$projectId`, attributed project activity for readers). Non-members/out-of-scope callers get `404`; agent keys are rejected; no event ever carries a secret.
- **Account deactivation**: `POST /api/admin/accounts/{humanId}/deactivate` (ends browser sessions, revokes all agent keys and project grants, releases active claims, and suspends shared memberships preserving `is_former_owner` in one transaction; refuses the last active admin) and `POST /api/admin/accounts/{humanId}/reactivate` (restores login and personal workspace only — never revives shared memberships, grants, or old keys).

## Recipe

```bash
A=$RUN_DIR/admin.jar; M=$RUN_DIR/member.jar
# Scoped history feeds:
curl -fsS -b "$A" "$URL/api/installation/history" | jq 'length'
curl -fsS -b "$A" "$URL/api/workspaces/$WS/history" | jq 'length'
curl -fsS -b "$A" "$URL/api/projects/$PID/history" | jq 'length'

# Deactivate member -> immediate 401 on existing session -> reactivate:
curl -fsS -b "$A" -X POST "$URL/api/admin/accounts/$MEMBER_ID/deactivate" >/dev/null
curl -sS -o /dev/null -w '%{http_code}\n' -b "$M" "$URL/api/my-work"   # 401
curl -fsS -b "$A" -X POST "$URL/api/admin/accounts/$MEMBER_ID/reactivate" >/dev/null
```

## Gotchas

- System administrators see installation history only; the admin role alone grants zero access to private workspace or project history (`404`).
- Reactivating a human does not restore prior shared-workspace memberships, project grants, or revoked agent keys; they must be re-invited and issue new keys.
