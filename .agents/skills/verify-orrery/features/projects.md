# Projects, issues, knowledge, and project access

A signed-in human creates a project in their personal workspace or, in a shared
workspace, with authority from the workspace. A personal project is private to its owner.
A shared project uses three cumulative levels (issue #27):

| Level | Allows |
| --- | --- |
| Read | View the project, its issues, comments, activity, and knowledge. |
| Contribute | Read, plus create/edit/close/reopen issues, comment, and create/edit knowledge. |
| Manage | Contribute, plus rename the project and manage project access grants. |

A workspace owner has Manage on every project in the workspace. A member's explicit grant
is the only other source; workspace membership alone reveals nothing. The system
administrator has no project access from the role.

## Sub-features

- `project-personal` a personal workspace's owner lists, creates, and manages its
  projects; another human can neither list the workspace's projects nor fetch one by id.
- `project-shared-owner` a shared workspace owner lists and creates projects and has
  Manage on every one.
- `create-projects` an owner grants a member the Create projects capability; the member
  creates a project and receives an explicit Manage grant on it.
- `project-levels` Read cannot mutate; Contribute can work but not configure; Manage can
  rename, list grants, grant a member, and revoke a grant.
- `project-access-scope` a grant targets a current member of the project's shared
  workspace; personal projects have no collaborators; grant changes are attributed
  events in Postgres.
- `project-denials` cross-workspace requests and another human's personal project answer
  404; a visible project below the required level answers 403
  `insufficient_project_access`.
- `issue-cycle` create an issue (project-local number, open), edit it, comment, close,
  and reopen it. `closedAt` follows the status.
- `knowledge` create and edit a basic Markdown entry; this is not the vault editor (#6).
- `activity` project creation, rename, issue, comment, close/reopen, and knowledge events
  keep the human who caused them.

## Preconditions

- A fresh instance with `BOOTSTRAP_SECRET`; the administrator created at `/setup` and
  signed in (`admin.jar`).
- For a second account, use an installation invitation and Mailpit (see
  [invitations](./invitations.md)); for a workspace member, invite them into the shared
  workspace and accept or register (see [workspaces](./workspaces.md)).
- `. $RUN_DIR/env` from the run; `SK=.agents/skills/verify-orrery/scripts`.

## Recipe

1. Sign in and create the shared workspace:

   ```bash
   curl -sS -c $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"email":"admin@orrery.test","password":"browser-checked-admin-password"}' \
     $URL/api/auth/login >/dev/null
   WORKSPACE=$(curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"name":"Live Access Lab"}' $URL/api/workspaces | jq -r .id)
   ```

2. Invite the member and read the caught token (Mailpit is up and SMTP is saved):

   ```bash
   curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"email":"live.member@orrery.test"}' \
     $URL/api/workspaces/$WORKSPACE/invitations
   ```

   Take the `/workspace-invitation?token=...` link from
   `http://127.0.0.1:$MAILPIT_HTTP/api/v1/messages`, register it with a password, then
   sign in as that account into `member.jar`. Find the member id from the owner's member
   directory:

   ```bash
   MEMBER_ID=$(curl -sS -b $RUN_DIR/admin.jar $URL/api/workspaces/$WORKSPACE/members \
     | jq -r '.[] | select(.email=="live.member@orrery.test") | .humanId')
   ```

3. Grant Create projects, then create a project as each actor:

   ```bash
   curl -sS -b $RUN_DIR/admin.jar -X PATCH -H 'content-type: application/json' \
     -d '{"canCreateProjects":true}' \
     $URL/api/workspaces/$WORKSPACE/members/$MEMBER_ID
   PROJECT=$(curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"name":"Owner Project"}' $URL/api/workspaces/$WORKSPACE/projects | jq -r .id)
   MEMBER_PROJECT=$(curl -sS -b $RUN_DIR/member.jar -H 'content-type: application/json' \
     -d '{"name":"Member Project"}' $URL/api/workspaces/$WORKSPACE/projects | jq -r .id)
   ```

   `MEMBER_PROJECT` must report `"accessLevel":"manage"`; its creator grant is real.

4. Walk the levels against the owner's project. The member id and email are used by the
   grant route:

   ```bash
   grant() { curl -sS -b $RUN_DIR/admin.jar -X PATCH -H 'content-type: application/json' \
     -d "{\"email\":\"live.member@orrery.test\",\"level\":\"$1\"}" \
     $URL/api/projects/$PROJECT/access; }
   grant read
   # Reads: 200. Mutations and management: 403 insufficient_project_access.
   curl -sS -b $RUN_DIR/member.jar $URL/api/projects/$PROJECT
   curl -sS -o /dev/null -w '%{http_code}\n' -b $RUN_DIR/member.jar \
     -X PATCH -H 'content-type: application/json' -d '{"name":"No"}' \
     $URL/api/projects/$PROJECT

   grant contribute
   # Create/edit/comment/close/reopen and knowledge: allowed. Rename and access: 403.
   ISSUE=$(curl -sS -b $RUN_DIR/member.jar -H 'content-type: application/json' \
     -d '{"title":"Member issue"}' $URL/api/projects/$PROJECT/issues | jq -r .id)
   curl -sS -b $RUN_DIR/member.jar -X PATCH -H 'content-type: application/json' \
     -d '{"status":"closed"}' $URL/api/issues/$ISSUE

   grant manage
   # Rename succeeds and the access list is readable.
   curl -sS -b $RUN_DIR/member.jar -X PATCH -H 'content-type: application/json' \
     -d '{"name":"Owner Project Renamed"}' $URL/api/projects/$PROJECT
   curl -sS -b $RUN_DIR/member.jar $URL/api/projects/$PROJECT/access
   ```

5. Prove the denials directly, not through UI controls:

   ```bash
   # Another human's personal project: 404, never its contents.
   PERSONAL=$(curl -sS -b $RUN_DIR/admin.jar $URL/api/workspaces \
     | jq -r '.[] | select(.kind=="personal") | .id')
   PRIVATE=$(curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"name":"Private Project"}' $URL/api/workspaces/$PERSONAL/projects | jq -r .id)
   curl -sS -o /dev/null -w '%{http_code}\n' -b $RUN_DIR/member.jar \
     $URL/api/projects/$PRIVATE          # 404
   curl -sS -o /dev/null -w '%{http_code}\n' -b $RUN_DIR/member.jar \
     $URL/api/workspaces/$PERSONAL/projects   # 404
   ```

   The administrator has no project access from the role: create a second account (its
   own personal workspace), create a private project there, and fetch it with
   `admin.jar`; the answer is 404. Cross-workspace members get the same 404 for a project
   in a workspace they do not belong to.

6. Browser proof: sign in as the owner, open the shared project, and grant a member
   through `Email` + `Access level` + `Grant access`. The `li[data-project-access-for]`
   row appears. A Read member's project page shows no Create issue, Project settings, or
   Project access controls (the committed `project-access.spec.ts` drives these).

7. Database checks:

   ```bash
   CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select p.name, pag.level, h.email from project_access_grants pag join projects p on p.id=pag.project_id join humans h on h.id=pag.human_id order by p.name, h.email"
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select type, level, previous_level, subject_human_id from project_access_events order by created_at"
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select type, actor_human_id, subject_human_id from workspace_events order by created_at"
   ```

   Grant changes must be present as proof they were transactional, not UI-only. A direct
   insert of a grant on a personal project is refused by the trigger
   `project_access_grant_shared_only`; one for a non-member is refused by
   `project_access_grant_member`.

## Gotchas

- 404 for no access and for missing ids is deliberate: project and workspace ids cannot
  be enumerated. 403 `insufficient_project_access` appears only when the caller can
  already see the project.
- Workspace owners do not appear in the explicit grant list; their Manage is implicit.
  The owner also always holds Create projects, whatever the stored member flag says.
- Removing a member deletes their project grants in that workspace and records
  revocation events, so a rejoin cannot revive an old level.
- Issue numbers restart at 1 per project; the id is the stable identity.
- Activity is chronological and stores a title snapshot; renaming an issue later does
  not rewrite history.
- The project page shows raw Markdown with preserved whitespace; there is no renderer and
  no vault editor.
