# Workspaces, transfers, and ownership recovery

Every human has one private `Personal` workspace and can create or join `Shared` workspaces. On `/workspaces/$workspaceId`, the Astryx UI uses tabs (`Projects`, `Agents`, `Runs`, and conditional `Members`, defaulting to `Projects`), with header buttons opening drawers for `New project` and `Invite member` plus an `Access history` link.

## Sub-features

- `workspaces-and-delegation` `GET/POST /api/workspaces`, `GET /api/workspaces/{workspaceId}/members`, `PATCH /api/workspaces/{workspaceId}/members/{humanId}` (four capabilities: `canCreateProjects`, `canInviteMembers`, `canRemoveMembers`, `canManageMemberPermissions`, strictly capped by caller authority; non-members get `404 workspace_not_found`), `POST /api/workspaces/{workspaceId}/owners`, and `DELETE /api/workspaces/{workspaceId}/members/{humanId}`.
- `workspace-leave` `POST /api/workspaces/{workspaceId}/leave` (`204` for members; `409 last_owner` for the last owner; revokes workspace keys, project grants, and active work sessions in one transaction).
- `workspace-invitations` `GET/POST /api/workspaces/{workspaceId}/invitations`, `resend`/`revoke`, `GET /api/workspace-invitations/preview`, and `POST /api/workspace-invitations/{acceptance,registration,decline}` (enforcing `account_deactivated` and `ownerless_workspace` guards).
- `project-transfers` `POST /api/projects/{projectId}/transfer{/preview,/complete}` and `POST /api/transfers/{preview,accept}` for personal-to-shared and shared-to-shared moves (rechecking authorities and no live work in one transaction, cleaning source grants/keys/pending offers).
- `ownership-recovery` `GET /api/admin/workspaces` (minimal directory, no project content) and `POST /api/admin/workspaces/{workspaceId}/recover-ownership` for ownerless shared workspaces (refusing active owners, self-promotion, and deactivated targets).

## Recipe

```bash
J='content-type: application/json'; A=$RUN_DIR/admin.jar; M=$RUN_DIR/member.jar
WS=$(curl -fsS -b "$A" -X POST "$URL/api/workspaces" -H "$J" -d '{"name":"Verify Team"}' | jq -r .id)
curl -fsS -b "$A" -X POST "$URL/api/workspaces/$WS/invitations" -H "$J" -d '{"email":"member@orrery.test"}' >/dev/null
# Read token from Mailpit, accept with $M via POST /api/workspace-invitations/acceptance, then:
MEMBER_ID=$(curl -fsS -b "$A" "$URL/api/workspaces/$WS/members" | jq -r '.[] | select(.email=="member@orrery.test") | .humanId')
curl -fsS -b "$A" -X PATCH -H "$J" -d '{"canCreateProjects":true}' "$URL/api/workspaces/$WS/members/$MEMBER_ID"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$A" -X POST "$URL/api/workspaces/$WS/leave"   # 409 last_owner
curl -fsS -b "$A" "$URL/api/admin/workspaces" | jq 'length'
```

For UI verification on `/workspaces/$WS`, sign in via Playwright and assert the `Projects`, `Agents`, `Runs`, and `Members` tabs, the `New project` / `Invite member` drawers, and capability toggles under the `Members` tab.

## Gotchas

- Always pass `-H 'content-type: application/json'` (not a cookie-jar variable) on JSON `PATCH`/`POST` calls.
- Removing or leaving a shared workspace revokes the member's workspace agent keys, project grants, and active work sessions in one transaction.
- `tests/e2e/zz-shared-transfer.spec.ts` and `tests/e2e/zz-ownership-recovery.spec.ts` cover full multi-account transfer and ownership-recovery flows against the compose stack.
