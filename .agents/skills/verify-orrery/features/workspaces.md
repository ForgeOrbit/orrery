# Workspaces

A signed-in human sees their personal workspace and every shared workspace they belong to
in `Your workspaces` on the home page. Personal projects stay private to that human.
Shared workspaces are created by a human, who becomes their first owner; members join by
invitation, and only owners can appoint owners or manage workspace capabilities.

Issue #27 adds one delegated capability, **Create projects**. A member who holds it can
create a project in the shared workspace and receives Manage on that project. Issue #28
adds three independent capabilities: **Invite members**, **Remove members**, and
**Manage member permissions**. Owners hold all four implicitly; a delegate can change
only what they hold, never themselves or an owner, and only owners appoint or remove
permission managers. Project Manage is a project level, not workspace authority: it lets
a delegate offer that project in an invitation while they hold it, but grants none of the
four workspace capabilities. Membership alone grants no access to any existing project;
[projects](./projects.md) covers the Read/Contribute/Manage matrix.

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
- `delegated-capabilities` a member's effective capabilities come from the server on every
  load; only owners change `canManageMemberPermissions`, and a manager cannot grant or
  revoke a capability they lack or modify themselves or an owner.
- `delegated-removal` a member with Remove members sees the directory and can remove an
  ordinary member, but never an owner or a permission manager; owners keep full authority.
- `delegated-inviter-scope` a delegated inviter may offer membership and only those project
  grants whose project they currently Manage; owners may offer any workspace project. A
  pending offer is rejected at both acceptance paths with `inviter_not_authorized` if the
  inviter loses membership, verified email, Invite members, or that project Manage.
- `delegation-events` every real capability change records an attributed row in
  `workspace_events`; no-op changes record nothing.

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
     "select w.name, h.email, m.is_owner, m.can_create_projects, m.can_invite_members, m.can_remove_members, m.can_manage_member_permissions from workspace_memberships m join workspaces w on w.id=m.workspace_id join humans h on h.id=m.human_id order by w.name, h.email"
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select type, actor_human_id, subject_human_id from workspace_events order by created_at"
   ```

## Issue #28: delegation ceilings and withdrawn inviter authority

Use the shared workspace from the main recipe. The administrator must be verified first
(`POST /api/settings/smtp/test`, then redeem the Mailpit token through
`POST /api/settings/email-verification`), or every invitation answers 403 `inviter_unverified`.
Keep one cookie jar per account; the shortcuts below use `$J` for the acting account and
`$A` for the administrator. `$WORKSPACE`, `$MEMBER`, `$TARGET`, and `$PROJECT` are ids.

1. **Grant and ceiling.** Give one member Manage member permissions and Create projects;
   let them read the directory and change a capability they hold, then show the refusals:

   ```bash
   curl -fsS -b "$A" -X PATCH -H "$J" \
     -d '{"canManageMemberPermissions":true,"canCreateProjects":true}' \
     $URL/api/workspaces/$WORKSPACE/members/$MEMBER
   curl -fsS -b "$J" $URL/api/workspaces/$WORKSPACE/members          # 200
   curl -sS -o /dev/null -w '%{http_code}\n' -b "$J" -X PATCH -H "$J" \
     -d '{"canManageMemberPermissions":true}' \
     $URL/api/workspaces/$WORKSPACE/members/$TARGET                 # 403 not_workspace_owner
   curl -sS -o /dev/null -w '%{http_code}\n' -b "$J" -X PATCH -H "$J" \
     -d '{"canInviteMembers":true}' \
     $URL/api/workspaces/$WORKSPACE/members/$TARGET                 # 403 (above own access)
   curl -sS -o /dev/null -w '%{http_code}\n' -b "$J" -X PATCH -H "$J" \
     -d '{"canCreateProjects":false}' \
     $URL/api/workspaces/$WORKSPACE/members/$MEMBER                 # 403 (self)
   curl -sS -o /dev/null -w '%{http_code}\n' -b "$A" -X PATCH -H "$J" \
     -d '{"canCreateProjects":true}' \
     $URL/api/workspaces/$WORKSPACE/members/$MEMBER                 # 200, no event
   ```

   A non-member's `GET /members`, `PATCH /members/:id`, and `DELETE /members/:id` all answer
   404 `workspace_not_found`, never 403; an ordinary member's `GET /members` answers 403.

2. **Removal ceiling.** Grant Remove members to a different member. They can remove an
   ordinary member but get 403 removing an owner or a permission manager. Owners can remove
   either, subject to `last_owner`.

3. **Project Manage is not workspace authority.** Grant a member project Manage with
   `PATCH /api/projects/$PROJECT/access` using `{"email":...,"level":"manage"}`. That member
   gets 403 on workspace member listing, capability changes, removal, invitation
   listing/creation/resend/revoke, and project creation.

4. **Delegated inviter scope.** Grant Invite members to a fourth member. They may create a
   plain invitation (`projectGrants: []`), but offering `$PROJECT` before they Manage it is
   403. After the owner grants them project Manage, the same offer succeeds, and resend and
   revoke of that offer succeed. Withdraw the project Manage grant with
   `DELETE /api/projects/$PROJECT/access/$MANAGER_ID`: the recipient's `POST
   /api/workspace-invitations/acceptance` and a new email's `POST
   /api/workspace-invitations/registration` both answer 403 `inviter_not_authorized`, while
   `GET /api/workspace-invitations/preview?token=...` still shows the pending offer.

5. **Withdrawal of Invite members.** Let another inviter send a plain offer, revoke their
   `canInviteMembers`, and repeat the acceptance: 403 `inviter_not_authorized`, the
   invitation remains pending, and no membership or account was created. The
   real-Postgres suite asserts the rolled-back rows; here confirm with:

   ```bash
   CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
   docker exec $CONTAINER psql -U orrery -d orrery -Atc \
     "select email, status from workspace_invitations where workspace_id='$WORKSPACE' and status='pending'"
   ```

6. **Browser authority.** Sign in as a delegate and open `/workspaces/$WORKSPACE`. A
   permission manager sees Members and only the controls for capabilities they hold; an
   inviter with Manage member permissions also sees the invite form and invitation history.
   Nobody but an owner sees `Make owner`, and a member with only project Manage sees no
   member or invitation sections. `browse.mjs` drives one page per process, so a signed-in
   workspace view needs a short one-off Playwright script that signs in, then navigates to
   the workspace and asserts the role-named controls; save its PNG/ARIA/JSON under
   `$RUN_DIR/evidence/`.

7. **Attributed events.** All six new capability types appear with the acting and subject
   human ids:

   ```bash
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select type, actor_human_id, subject_human_id from workspace_events \
      where workspace_id='$WORKSPACE' and (type like '%_granted' or type like '%_revoked') \
      order by created_at, id"
   ```

   Finally confirm `$RUN_DIR/server.log` has no `error`/`warn` lines, then
   `$SK/orrery-verify.sh down $RUN_DIR`.

## Gotchas

- Ordering is `createdAt`; equal timestamps make the order unstable.
- The administrator has no cross-account visibility by design; do not report it as a
  bug. Installation administration and project access are separate.
- A workspace owner's four capabilities are effectively true even if the stored member
  flags are false; the database flags matter for members. Setting an owner capability true
  is a no-op and setting it false is 409 `workspace_owner_capability`.
- Event ordering is by `createdAt` then id; equal timestamps order by random UUID. Compare
  event sets with counts, not exact order.
- A non-member probe of any shared-workspace endpoint answers 404 `workspace_not_found`,
  including PATCH and DELETE; only an existing member without the capability answers 403.
- `workspace_ownership_guards` serializes ownership changes. Remove members in the
  documented order (events, invitations, memberships, workspace) if cleaning up by hand;
  membership removal normally goes through the service.
- The web query maps 401 to an empty array, so the UI cannot distinguish signed-out
  from workspace-less; the HTTP proof carries that distinction.
