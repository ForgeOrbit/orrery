# Workspaces

A signed-in human sees their personal workspace and every shared workspace they belong to
in `Your workspaces` on the home page. Personal projects stay private to that human.
Shared workspaces are created by a human, who becomes their first owner; members join by
invitation, and only owners can appoint owners or manage workspace capabilities.

Issue #27 adds one delegated capability, **Create projects**. A member who holds it can
create a project in the shared workspace and receives Manage on that project. The project
still belongs to the workspace. Membership alone grants no access to any existing
project; [projects](./projects.md) covers the Read/Contribute/Manage matrix.

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
- `workspace-owner` the creator is the first owner; another owner can be appointed; the
  last owner cannot be removed.
- `create-projects` an owner grants or revokes a member's Create projects capability. The
  member workspace reports `canCreateProjects`, the member directory shows it, and the
  workspace event records the change.
- `member-removal` removal ends that human's project grants in the workspace in the same
  transaction, so a rejoin starts with fresh grants.

## Preconditions

- A fresh instance with `BOOTSTRAP_SECRET`; the administrator created at `/setup`, signed
  in (`admin.jar`), and SMTP saved.
- A second account needs an installation invitation and Mailpit (see
  [invitations](./invitations.md)); there is no public sign-up.
- For shared-workspace membership, the owner invites the existing account and it accepts
  through the workspace invitation link, or a new email registers through that link.

## Recipe

1. Create the administrator and sign in, then invite and register a second person
   (`newcomer.jar`), as in the accounts and invitations recipes.

2. List over HTTP and compare by id, not by wording:

   ```bash
   curl -sS -b $RUN_DIR/admin.jar $URL/api/workspaces
   curl -sS -b $RUN_DIR/newcomer.jar $URL/api/workspaces
   ```

   Each includes exactly one `kind:"personal"` workspace; the ids differ, and neither
   listing contains the other's personal id.

3. Create a shared workspace and invite the second person:

   ```bash
   WORKSPACE=$(curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"name":"Live Team"}' $URL/api/workspaces | jq -r .id)
   PROJECT=$(curl -fsS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"name":"Guidance"}' $URL/api/workspaces/$WORKSPACE/projects | jq -er .id)
   jq -nc --arg id "$PROJECT" \
     '{email:"newcomer@orrery.test",projectGrants:[{projectId:$id,level:"contribute"}]}' | \
     curl -fsS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     --data-binary @- $URL/api/workspaces/$WORKSPACE/invitations
   ```

   Open the caught `/workspace-invitation?token=...` link as the newcomer. Before accepting,
   confirm the page shows `Guidance: contribute`. GET `/api/workspace-invitations/preview`
   with the same token and confirm its `project_access` grant matches the project ID,
   name, and level. Accept as the signed-in newcomer, then GET `/api/projects/$PROJECT`
   with `newcomer.jar` and confirm it returns the invited project.

4. Prove owner authority and the capability ceiling:

   ```bash
   curl -sS -b $RUN_DIR/admin.jar $URL/api/workspaces/$WORKSPACE/members
   MEMBER_ID=$(curl -sS -b $RUN_DIR/admin.jar $URL/api/workspaces/$WORKSPACE/members \
     | jq -r '.[] | select(.email=="newcomer@orrery.test") | .humanId')

   # Create projects is granted by an owner; the member is not an owner.
   curl -sS -b $RUN_DIR/admin.jar -X PATCH -H 'content-type: application/json' \
     -d '{"canCreateProjects":true}' \
     $URL/api/workspaces/$WORKSPACE/members/$MEMBER_ID

   # A member cannot manage the capability or appoint an owner.
   curl -sS -o /dev/null -w '%{http_code}\n' -b $RUN_DIR/newcomer.jar \
     -X PATCH -H 'content-type: application/json' -d '{"canCreateProjects":true}' \
     $URL/api/workspaces/$WORKSPACE/members/$MEMBER_ID     # 403 not_workspace_owner
   ```

5. List from the member's side: its new project appears; the owner's project does not
   until granted. See [projects](./projects.md) for creating and granting.

6. Browser proof as the invited person (the 401 is the session check on `/signin`):

   ```bash
   node $SK/browse.mjs $RUN_DIR /signin --allow-http 401 --slug workspace-newcomer \
     --fill "Email=newcomer@orrery.test" --fill "Password=invited-newcomer-password" \
     --click-button "Sign in" --expect-text "Signed in as newcomer@orrery.test." \
     --expect-role "heading:Your workspaces" --expect-text "Personal"
   ```

   As the owner, open `/workspaces/$WORKSPACE`; the member row offers
   `Grant Create projects`/`Revoke Create projects`, and toggling it updates the effective
   label from the server.

7. Database join: one personal workspace per human, memberships and capability in the
   shared one, and an event for a capability change.

   ```bash
   CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select h.email, w.kind, w.name from humans h join workspaces w on w.personal_owner_human_id = h.id order by h.email"
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select w.name, h.email, m.is_owner, m.can_create_projects from workspace_memberships m join workspaces w on w.id=m.workspace_id join humans h on h.id=m.human_id order by w.name, h.email"
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select type, actor_human_id, subject_human_id from workspace_events order by created_at"
   ```

## Gotchas

- Ordering is `createdAt`; equal timestamps make the order unstable.
- The administrator has no cross-account visibility by design; do not report it as a
  bug. Installation administration and project access are separate.
- A workspace owner's `canCreateProjects` is effectively true even if the stored member
  flag is false; the database flag matters for members.
- `workspace_ownership_guards` serializes ownership changes. Remove members in the
  documented order (events, invitations, memberships, workspace) if cleaning up by hand;
  membership removal normally goes through the service.
- The web query maps 401 to an empty array, so the UI cannot distinguish signed-out
  from workspace-less; the HTTP proof carries that distinction.
