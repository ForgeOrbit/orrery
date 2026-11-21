# Projects, six-state board, labels, subtasks, links, dependencies, knowledge, and Trash

Projects live in a personal or shared workspace with cumulative `read`/`contribute`/`manage` access and an immutable workspace-unique `key` producing `<KEY>-<N>` issue identifiers. Issues follow the fixed six-state workflow (`backlog`, `todo` default, `in_progress`, `review`, `done`, `cancelled`; `closedAt` is set iff terminal `done`/`cancelled`), with safe GFM Markdown + Mermaid rendering, project-scoped labels, 1-level subtasks, typed external links (`pr`/`commit`/`doc`/`link`), acyclic `blocked-by` dependencies, basic Markdown knowledge entries, 30-day soft-delete Trash, and 25 MCP tools.

## Sub-features

- `project-access` cumulative `read`/`contribute`/`manage` grants (`GET/PATCH/DELETE /api/projects/{projectId}/access`), implicit owner `manage`, `404` non-enumeration for outsiders/personal projects, `403 insufficient_project_access` for visible projects below level.
- `six-state-issues` create (`status: "todo"` default, `identifier: "<KEY>-<N>"`), edit (`status`, `priority`, `sortOrder`, `assignee`), comment, close (`done`/`cancelled` sets `closedAt`), reopen.
- `labels-subtasks-links-deps` `POST/PATCH/DELETE /api/projects/{id}/labels`, `POST/DELETE /api/issues/{id}/labels/{labelId}`, 1-level `parentIssueId`, `POST/DELETE /api/issues/{id}/links`, `POST/DELETE /api/issues/{id}/blocked-by`.
- `trash` human Contribute/Manage `DELETE /api/issues/{id}` (refused with `409` if active session; agents refused), Manage `GET /api/projects/{id}/trash` and `POST /api/issues/{id}/restore` (within 30 days in DB time), hourly 30-day tombstone scrub.
- `web-surfaces` `/projects/$projectId` (`New issue`, `Settings` tab for rename/access/fallback policy), `/board/$projectId` (6-column drag-and-drop board + filters), `/issues/$issueId` (GFM + Mermaid + subtasks + links + sidecar session inspector), `/trash/$projectId`, `/knowledge/$entryId`.

## Recipe

```bash
J='content-type: application/json'; A=$RUN_DIR/admin.jar; M=$RUN_DIR/member.jar
PID=$(curl -fsS -b "$A" -X POST "$URL/api/workspaces/$WS/projects" -H "$J" -d '{"name":"Verify Lab","key":"LAB"}' | jq -r .id)
curl -fsS -b "$A" -X PATCH "$URL/api/projects/$PID/access" -H "$J" -d '{"email":"member@orrery.test","level":"contribute"}' >/dev/null
I1=$(curl -fsS -b "$A" -X POST "$URL/api/projects/$PID/issues" -H "$J" -d '{"title":"Parent issue"}' | jq -r .id)
I2=$(curl -fsS -b "$A" -X POST "$URL/api/projects/$PID/issues" -H "$J" -d "{\"title\":\"Subtask\",\"parentIssueId\":\"$I1\"}" | jq -r .id)
LBL=$(curl -fsS -b "$A" -X POST "$URL/api/projects/$PID/labels" -H "$J" -d '{"name":"backend","color":"#2563eb"}' | jq -r .id)
curl -fsS -b "$A" -X POST "$URL/api/issues/$I1/labels/$LBL" >/dev/null
curl -fsS -b "$A" -X POST "$URL/api/issues/$I1/links" -H "$J" -d '{"url":"https://github.com/forge-orbit/orrery/pull/1","title":"PR #1","kind":"pr"}' >/dev/null
curl -fsS -b "$A" -X PATCH "$URL/api/issues/$I1" -H "$J" -d '{"status":"done"}' | jq -c '{identifier, status, closedAt}'
curl -fsS -b "$M" -X DELETE "$URL/api/issues/$I2" -o /dev/null -w '%{http_code}\n'   # 204
curl -fsS -b "$A" "$URL/api/projects/$PID/trash" | jq 'length'                      # 1
curl -fsS -b "$A" -X POST "$URL/api/issues/$I2/restore" | jq -c '{identifier, status}'
```

## Gotchas

- `"closed"` is NOT a valid `IssueStatus`; use `"done"` or `"cancelled"` (both set `closedAt`).
- Issues, comments, and knowledge entries render safe GFM Markdown + Mermaid (raw HTML stripped) via `<Markdown>`.
- Committed e2e specs: `tests/e2e/team-project-access.spec.ts` and the M4 board/trash specs.
