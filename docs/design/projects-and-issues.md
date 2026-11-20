# Projects and issues

Product and engineering decisions are agreed for M2 ([#3](https://github.com/forge-orbit/orrery/issues/3)), building on [Identity, workspaces, and agent work sessions](./mvp-spec.md) and [Agent board interaction](./agent-board-interaction.md).

## Problem Statement

Orrery's current project and issue data model only distinguishes `open` from `closed`, lacks human-readable project key prefixes (`ORR-42`), and has no project-scoped labels, one-level subtasks, or soft-delete recovery. Without a structured six-state workflow that separates `backlog` triage from `todo` ready work and `review` handoff, teams cannot stage work cleanly for humans and agents. Without soft-delete recovery, accidental deletions risk permanent loss or broken `project_activity` audit references.

## Solution

Extend the projects and issues domain with:

- A fixed six-state issue workflow (`backlog`, `todo`, `in_progress`, `review`, `done`, `cancelled`) paired with the orthogonal `needs_input` flag derived from `questions` ([ADR-0005](../adr/0005-issue-workflow-and-derived-needs-input.md)).
- Workspace-unique, immutable project key prefixes (`ORR` → `ORR-42`), with conflict-resolving rename allowed only during workspace transfer acceptance.
- Project-scoped labels and one-level subtasks (`parent_issue_id`) that remain full, independently claimable issues.
- Human-only soft-delete (`deleted_at`) with a 30-day trash window, Project manager restore, and in-place tombstone scrubbing (`purged_at`) after 30 days ([ADR-0006](../adr/0006-soft-delete-and-tombstone-scrubbing.md)).

## User Stories

### Fixed six-state workflow

1. As a human contributor, I want to place unrefined issues in `backlog` and ready issues in `todo`, so that agents only pull work that is ready to start.
2. As a human contributor, I want issues to move through a fixed six-state workflow (`backlog`, `todo`, `in_progress`, `review`, `done`, `cancelled`), so that humans and agents share one predictable state machine across every project.
3. As a human contributor, I want `done` and `cancelled` to both count as terminal states that set `closed_at` and unblock dependent `blocked_by` issues, so that cancelled blockers do not freeze downstream work.
4. As a human contributor, I want `review` to remain non-terminal, so that downstream dependent issues stay blocked until the blocker is actually `done`.
5. As a human member, I want `needs_input` to stay derived from open or paused `questions` rather than a manual status value, so that the issue state never drifts from the needs-input inbox.

### Project keys

6. As a human member, I want every project to have a short uppercase project key (such as `ORR`), so that issues have readable identifiers like `ORR-42` across the board, PRs, commits, and vault notes.
7. As a workspace member, I want project keys to be unique within a workspace and immutable after creation, so that external links and vault references never break.
8. As an installer upgrading an existing database, I want existing projects to receive auto-derived unique project keys during migration, so that no manual backfill is required.
9. As a workspace owner accepting a project transfer, I want to supply a new unused project key if the destination workspace already uses that key, so that key collisions do not block valid transfers.

### Labels and one-level subtasks

10. As a project contributor, I want to create, edit, and delete project-scoped labels and attach them to issues, so that I can categorize work (such as `bug`, `task`, or area tags) and filter the board.
11. As a human or agent contributor, I want to create one-level subtasks under a parent issue in the same project, so that larger work can be broken into concrete pieces without deep hierarchy.
12. As a human contributor, I want open subtasks not to automatically block claiming or closing the parent issue, so that explicit `blocked_by` dependencies remain the single source of truth for ordering.

### Soft-delete and 30-day trash

13. As a human contributor or project manager, I want to soft-delete an issue into trash, so that mistaken deletions can be recovered.
14. As a workspace owner, I want agents blocked from deleting issues, so that a misbehaving agent cannot wipe out project work.
15. As a human contributor, I want soft-deleting an issue with an active work session to be rejected, so that active work must be stopped or released before trashing the issue.
16. As a human member, I want soft-deleted issues excluded from default issue lists, search, `list_ready_work`, and `blocked_by` checks, so that trashed issues never block active work.
17. As a project manager, I want to restore a soft-deleted issue from trash within 30 days, so that accidental deletions are reversible.
18. As a system administrator, I want trashed issues older than 30 days to have their mutable content scrubbed in place while keeping a minimal tombstone, so that old content is removed without breaking `project_activity` audit history or issue numbering.

## Implementation Decisions

### Six-state issue status and terminal invariants

- Replace the binary `issues.status` enum (`open | closed`) with `backlog`, `todo`, `in_progress`, `review`, `done`, `cancelled`, enforced by a database CHECK constraint.
- Migrate existing `open` issues to `todo` and existing `closed` issues to `done`.
- Update the `closed_at` database invariant so `closed_at` is non-null if and only if `status` is `done` or `cancelled`.
- Update `blocked_by` dependency checks so a blocker is satisfied when its status is `done` or `cancelled` (or when it is soft-deleted). `review` remains non-terminal and blocking.
- Keep `needs_input` as a boolean synced strictly from `questions` ([ADR-0005](../adr/0005-issue-workflow-and-derived-needs-input.md)).

### Project keys

- Add a required `key` column on `projects`: uppercase alphanumeric (`^[A-Z][A-Z0-9]{1,9}$`, 2–10 characters), enforced by a database CHECK constraint and a unique index on `(workspace_id, key)`.
- Auto-derive a valid unique uppercase key for any existing project in the migration from its name (with a deterministic numeric suffix on workspace collision).
- Treat `projects.key` as immutable on ordinary project updates.
- During workspace transfer acceptance, if the destination workspace already contains a project with the same `key`, reject acceptance with a conflict error unless the acceptance request supplies a new unused `key` for the destination workspace, applied atomically in the transfer transaction.
- Expose the formatted issue identifier (`<PROJECT_KEY>-<NUMBER>`) in REST and MCP issue payloads alongside `id` and `number`.

### Labels and subtasks

- Add project-scoped `project_labels` (`id`, `project_id`, `name`, `color`, timestamps) with case-insensitive uniqueness per project, and a join table `issue_labels` (`issue_id`, `label_id`) with composite uniqueness and same-project enforcement.
- Allow humans and agents with `Contribute` or `Manage` on the project to manage labels and attach/detach them on issues over REST and MCP.
- Add an optional nullable `parent_issue_id` foreign key on `issues` referencing `issues(id)`.
- Enforce three invariants in both the service and database (CHECK / trigger):
  1. An issue cannot be its own parent (`parent_issue_id <> id`).
  2. Parent and child must belong to the same `project_id`.
  3. Maximum nesting depth is one: a subtask cannot be assigned as the parent of another issue, and an issue that already has subtasks cannot become a subtask.

### Soft-delete and tombstone scrubbing

- Add nullable `deleted_at`, `deleted_by_human_id`, and `purged_at` columns to `issues` (with CHECK constraints ensuring `deleted_at` and `deleted_by_human_id` are written together, and `purged_at` is set only when `deleted_at` is set; see [ADR-0006](../adr/0006-soft-delete-and-tombstone-scrubbing.md)).
- Soft-delete is restricted to **humans** with `Contribute` or `Manage` on the project; agent requests to delete an issue are rejected (`403`).
- Reject soft-delete (`409`) if the issue has an active work session.
- Soft-deleted issues are excluded from default issue listings, board views, search, `list_ready_work`, and `blocked_by` checks. Restoring a soft-deleted issue requires `Manage` (Project manager) and fails if `purged_at` is already set.
- Record `issue_deleted` and `issue_restored` events in `project_activity` in the same transaction.
- Run a 30-day background purge sweep (evaluated in database time) that scrubs mutable content in place for rows where `deleted_at <= now() - interval '30 days'` and `purged_at IS NULL`: clears `body`, deletes associated `issue_comments`, `issue_links`, `issue_labels`, and `issue_dependencies`, and sets `purged_at = now()`, preserving the tombstoned `issues` row and all `project_activity` history.

## Testing Decisions

- **Real-Postgres service tests**:
  - Six-state workflow and terminal invariants (`closed_at` iff `done | cancelled`; `blocked_by` unblocked on `done | cancelled | deleted`, still blocked on `review`).
  - Project keys: workspace uniqueness, immutability on update, migration backfill, and transfer collision rejection vs. rename-on-accept.
  - Labels and subtasks: case-insensitive label uniqueness per project, same-project subtask enforcement, and DB-enforced max depth of 1.
  - Soft-delete and 30-day scrub: human-only delete (`403` for agents), `409` when claimed, exclusion from listings and blockers, `Manage`-only restore, and 30-day scrub sweep under test clock control verifying content removal while `project_activity` rows and `ORR-N` numbers remain intact.
- **Black-box e2e tests (REST + MCP)**:
  - Create a project with a `key`, create parent issues and subtasks with labels, verify `KEY-N` identifiers, transition through the six states, and exercise soft-delete and restore.

## Out of Scope

- Custom per-project workflows or state groups.
- Epics, sprints/cycles, story points, separate `type` (`task`/`bug`) or `reviewer` columns.
- Binary or image file uploads (external links use `issue_links` from #87; uploads deferred to post-MVP).

## Further Notes

- Spec for [#3 — \[MVP\] M2: Projects and issues](https://github.com/forge-orbit/orrery/issues/3).
