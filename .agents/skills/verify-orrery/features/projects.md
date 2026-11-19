# Projects, issues, and knowledge

A signed-in human creates a project in their personal workspace, then runs a complete
issue cycle and writes basic Markdown knowledge in it. Projects are personal in this
release (#26): only the personal workspace's owner can list, create, or access one. Shared
workspaces gain project creation and the Read/Contribute/Manage levels with #27, so they
have no Projects section or project endpoints yet.

## Sub-features

- `project-create` a personal workspace's page lists its projects and offers a create form;
  `POST /api/workspaces/{workspaceId}/projects` returns 201 with the creator recorded.
- `project-private` signed-out requests to list or fetch a project answer 401
  `not_signed_in`.
- `issue-cycle` create an issue (project-local number 1, open), edit its title and Markdown
  body, comment, close it, and reopen it. `closedAt` is set while closed and null when open.
- `issue-authorship` each issue keeps its creator and last editor; each comment keeps its
  author.
- `knowledge` create and edit a basic Markdown entry; the creator and last editor are kept.
  This is not the full vault editor (#6).
- `activity` the project page lists creation, issue, comment, close/reopen, and knowledge
  events, each with the human who caused it and a title snapshot.
- `issue-numbers` numbers are per project and never repeat; concurrent creations serialize
  on the project row.

## Preconditions

- A fresh instance with `BOOTSTRAP_SECRET`; the administrator created at `/setup` and
  signed in (`admin.jar`). No second account or mail delivery is needed.
- `. $RUN_DIR/env` from the run; `SK=.agents/skills/verify-orrery/scripts`.

## Recipe

1. Sign in and find the personal workspace:

   ```bash
   curl -sS -c $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"email":"admin@orrery.test","password":"browser-checked-admin-password"}' \
     $URL/api/auth/login >/dev/null
   PERSONAL=$(curl -sS -b $RUN_DIR/admin.jar $URL/api/workspaces \
     | jq -r '.[] | select(.kind == "personal") | .id')
   ```

2. Create the project and capture its id:

   ```bash
   PROJECT=$(curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"name":"Live Project"}' \
     $URL/api/workspaces/$PERSONAL/projects | tee /dev/stderr | jq -r .id)
   ```

3. Run the issue cycle and capture the issue id:

   ```bash
   ISSUE=$(curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"title":"Live issue","body":"Draft **body**."}' \
     $URL/api/projects/$PROJECT/issues | tee /dev/stderr | jq -r .id)
   curl -sS -b $RUN_DIR/admin.jar -X PATCH -H 'content-type: application/json' \
     -d '{"title":"Live issue edited","body":"Edited **body**."}' $URL/api/issues/$ISSUE
   curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"body":"A live comment."}' $URL/api/issues/$ISSUE/comments
   curl -sS -b $RUN_DIR/admin.jar -X PATCH -H 'content-type: application/json' \
     -d '{"status":"closed"}' $URL/api/issues/$ISSUE
   curl -sS -b $RUN_DIR/admin.jar -X PATCH -H 'content-type: application/json' \
     -d '{"status":"open"}' $URL/api/issues/$ISSUE
   ```

4. Create and edit knowledge, then read the activity:

   ```bash
   ENTRY=$(curl -sS -b $RUN_DIR/admin.jar -H 'content-type: application/json' \
     -d '{"title":"Live knowledge","body":"# Notes\n\nMarkdown."}' \
     $URL/api/projects/$PROJECT/knowledge | tee /dev/stderr | jq -r .id)
   curl -sS -b $RUN_DIR/admin.jar -X PATCH -H 'content-type: application/json' \
     -d '{"title":"Live knowledge edited","body":"## Edited\n\nStill Markdown."}' \
     $URL/api/knowledge/$ENTRY
   curl -sS -b $RUN_DIR/admin.jar $URL/api/projects/$PROJECT/activity | jq
   ```

   Expect `project_created`, `issue_created`, `issue_edited`, `issue_commented`,
   `issue_closed`, `issue_reopened`, `knowledge_created`, `knowledge_edited`, each with
   `actor.email` equal to the administrator's address.

5. Prove the denial without a session:

   ```bash
   for PATH in \
     "/api/workspaces/$PERSONAL/projects" \
     "/api/projects/$PROJECT" \
     "/api/issues/$ISSUE" \
     "/api/projects/$PROJECT/knowledge"; do
     curl -sS -o /dev/null -w "%{http_code} $PATH\n" $URL$PATH
   done
   # every line is 401
   ```

6. Browser proof: the committed `tests/e2e/projects.spec.ts` drives the full cycle
   (sign in, create project, create/edit/comment/close/reopen issue, create/edit knowledge,
   read activity) and is the reference for a one-off Playwright script. `browse.mjs` creates
   a fresh browser per call, so a multi-step cycle needs one script; use the same
   `getByRole`/`getByLabel` handles, and save screenshots under `$RUN_DIR/evidence/`.

7. Database check:

   ```bash
   CONTAINER=$(sed -n 's/^CONTAINER=//p' $RUN_DIR/env)
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select p.name, i.number, i.status, i.created_by_human_id, i.updated_by_human_id from projects p join issues i on i.project_id = p.id order by p.created_at"
   docker exec $CONTAINER psql -U orrery -d orrery -c \
     "select type, actor_human_id, summary from project_activity order by created_at"
   ```

## Gotchas

- The project page shows raw Markdown with preserved whitespace. There is no renderer and
  no vault editor; that is deliberate for #26.
- Activity is chronological (oldest first) and its summary is the item's title at the time
  of the event, so renaming an issue later does not rewrite history.
- Issue numbers restart at 1 for each project; the id is the stable identity.
- Shared workspaces have no Projects section and answer project endpoints with 404; that
  surface arrives with #27.
- No project appears for a signed-out request: 401, `application/problem+json`, code
  `not_signed_in`.
