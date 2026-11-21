# Release polish (notifications, outgoing webhooks, docs, and release packaging)

Product and engineering decisions are agreed for M6 ([#7](https://github.com/forge-orbit/orrery/issues/7)), building on [Identity, workspaces, and agent work sessions](./mvp-spec.md), [Projects and issues](./projects-and-issues.md), [Agent API and sessions](./agent-api-and-sessions.md), and [Board, agents panel, inbox, and My work](./board-and-inbox.md). Manual PR/commit/doc links (`issue_links`, `#87`), 30-day Trash soft-delete ([ADR-0006](../adr/0006-soft-delete-and-tombstone-scrubbing.md)), needs-input SMTP email, and GHCR container builds are already shipped. M6 is self-contained on M0–M4 so future M5 vault activities plug into the same activity and webhook seam without blocking release.

## Problem Statement

Four gaps remain before a small team can run Orrery day-to-day in production:

1. **No in-app notifications**: humans have to poll boards manually to spot an agent `Handoff` to `Review`, a `Needs input` question (or 1-hour pause), or a stale `Work session` whose 5-minute `Claim` lease lapsed — and expired leases and question deadlines are only evaluated lazily when someone reads or writes the issue.
2. **No lightweight external integration seam**: `#7` Option A deferred a GitHub App in favor of outgoing webhooks on the activity log, which are not built yet.
3. **Missing day-one operator and agent onboarding docs**: there is no self-hosting install/upgrade guide, no Docker Postgres backup/restore runbook (including `ORRERY_ENCRYPTION_KEY` preservation), and no single "Connect an agent" quickstart covering Claude Code, Codex, and Cursor.
4. **Incomplete release automation**: pushing a `v*` tag builds GHCR images but does not publish a GitHub Release with notes and pull instructions, and `README.md` / `docs/README.md` still describe M4 UI as in progress.

## Solution

Deliver the four M6 release-polish slices:

- **Proactive expiry sweeper + `issue_session_expired` activity**: run a ~60-second background sweeper alongside the existing trash purge timer to evaluate lapsed 5-minute `Claim` leases and 1-hour question deadlines proactively (keeping lazy evaluation on all hot paths), recording an atomic `issue_session_expired` entry in `project_activity` when a lease lapses.
- **In-app notifications**: a minimal `read_at` `notifications` table populated atomically for `Handoff`, `Needs input` (asked/paused), and stale `Work session` events, filtered by live project access and Trash state on read, with a dedicated `Notifications` sidebar item + unread badge and `/notifications` view.
- **Outgoing webhooks** ([ADR-0007](../adr/0007-outgoing-webhooks-outbox-and-security.md)): Workspace-scoped subscriptions managed by `Workspace owner`s with a Postgres transactional outbox, HMAC-SHA256 signing encrypted at rest via `ORRERY_ENCRYPTION_KEY`, default-deny SSRF protection (with `ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS` opt-in), 5-attempt exponential backoff, auto-disable circuit breaker, and a Workspace `Webhooks` management tab.
- **Operator/agent docs & GHCR GitHub Releases**: ship `docs/guides/install.md`, `docs/guides/backup-and-restore.md`, `docs/guides/connect-agent.md`, refresh `README.md` and `docs/README.md`, and extend `.github/workflows/ci.yml` to publish GitHub Releases on `v*` tags (GHCR-only release channel).

## User Stories

### In-app notifications and proactive expiry

1. As a human member, I want an in-app notification whenever an agent hands off an issue to `Review` (where I am the human assignee, the agent's owner, or — if unassigned — the issue's human creator), asks a `Needs input` question or pauses after 1 hour (where I am the agent's owner or human assignee), or loses a `Claim` due to a 5-minute lease timeout (where I am the agent's owner or human assignee), so that I catch stalled or review-ready work promptly without polling every project.
2. As a human member, I want stale `Work session` leases and 1-hour question deadlines to expire proactively within ~60 seconds even when nobody has the board open, so that notifications and webhooks fire on time.
3. As a signed-in human, I want a `Notifications` item with an unread badge in the sidebar leading to `/notifications`, where I can filter `Unread` vs. `All`, click an item to mark it read and jump straight to the issue, or click `Mark all read`.
4. As a workspace administrator, I want notifications for revoked projects, suspended memberships, or trashed issues to disappear immediately from a human's feed and unread count (non-enumeration), and I want agents to be rejected (`403`) on notification endpoints.

### Outgoing webhooks

5. As a `Workspace owner` (or owner of a `Personal workspace`), I want to create, edit, enable/disable, rotate signing secrets for, and delete outgoing webhooks subscribed to all or selected projects and `ProjectActivityType` events in my workspace, so that external tools (Slack bridges, CI, automation) can react to Orrery activity.
6. As a webhook receiver author, I want every delivery to be a concise `version: 1` metadata-only JSON envelope signed with `X-Orrery-Signature-256` (`sha256=<hmac>` over `${timestamp}.${rawBody}`) using a server-generated `whsec_...` secret shown once on creation/rotation, so that I can verify authenticity and prevent replay attacks without sensitive Markdown bodies leaking into third-party logs.
7. As a `Workspace owner`, I want to send a `webhook.test` event and inspect the last 50 delivery attempts (HTTP status, latency, attempt count, sanitized error snippet), and I want permanently broken endpoints to auto-disable after 10 consecutive exhausted deliveries rather than retrying forever.
8. As a self-hosted operator, I want webhook delivery to require `https://`, disable redirects, and block loopback/private/cloud-metadata IPs at DNS resolution time by default, with an explicit `ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=true` env var when I deliberately connect Orrery to an internal LAN service.

### Docs and release packaging

9. As a self-hosted operator, I want a clear Install & upgrade guide and a verified Docker `pg_dump`/`pg_restore` Backup & restore runbook (calling out `ORRERY_ENCRYPTION_KEY` preservation) so that I can deploy, upgrade, and recover Orrery safely.
10. As a developer, I want a single-page "Connect an agent" guide covering Claude Code, Codex (via `forge-orbit/orrery-integrations` and raw `/mcp`), and Cursor (`.cursor/mcp.json`, noting run-reporting hooks are Claude Code & Codex only), so that I can connect my harness in minutes.
11. As a maintainer, I want pushing a `v*` tag to publish multi-arch GHCR images and automatically create a GitHub Release with release notes and the pull reference.

## Implementation Decisions

### Proactive expiry sweeper and `issue_session_expired`

- Add `"issue_session_expired"` to `ProjectActivityType` in `packages/contract/src/projects.ts` and regenerate migrations/contracts. Because it starts with `issue_`, the existing `project_activity_target_matches_type` Postgres CHECK constraint covers it automatically.
- Inside `work-sessions/service.ts` (`expireStale`), when an active session transitions to `expired`, insert an `issue_session_expired` row in `project_activity` (attributed to `actorAgentId = expired.agentId`) in the **same transaction** as the status flip and `in_progress → todo` revert.
- Add a lightweight background sweeper (every 60 seconds, `timer.unref()`, started from `main.ts` alongside `projects.startBackgroundTasks()`) that queries issues with `work_sessions.status = 'active' AND lease_expires_at <= statement_timestamp()` and `questions.status = 'open' AND response_deadline_at <= statement_timestamp()` and runs the existing row-locked `expireStale` / `evaluateDeadline` transactions per issue. Keep all existing lazy expiry calls intact on read/write paths.

### In-app notifications (`apps/server/src/features/notifications/`)

- **Schema**: `notifications` table:
  - `id` (`text` PK), `human_id` (`text` FK → `humans.id`), `project_id` (`text` FK → `projects.id`), `issue_id` (`text` FK → `issues.id`), `activity_id` (`text` FK → `project_activity.id`), `kind` (`text`, CHECK in `'handoff' | 'needs_input' | 'session_expired'`), `summary` (`text`), `read_at` (`timestamptz` nullable), `created_at` (`timestamptz` NOT NULL DEFAULT `now()`).
  - Do **not** denormalize `workspace_id` onto `notifications`; resolve live workspace membership through `projects.workspace_id` so project transfers never leave stale workspace references.
  - `UNIQUE (human_id, activity_id)` prevents duplicate notifications under any retry or race.
  - Indexes: `(human_id, created_at DESC)` and partial index `(human_id, created_at DESC) WHERE read_at IS NULL`.
- **Recipient resolution** (executed inside the same transaction that writes `project_activity`, skipping the triggering actor and any human who lacks active project `Read` access):
  - `issue_review_handoff` → `kind: "handoff"`: issue's human assignee (if any) + agent's human owner; if there is no human assignee, also the issue's human creator (if any).
  - `issue_question_asked` and `issue_question_paused` → `kind: "needs_input"`: agent's human owner + issue's human assignee (if any).
  - `issue_session_expired` → `kind: "session_expired"`: agent's human owner + issue's human assignee (if any).
- **REST contract** (registered via `createRoute` + `app.openapi`, human session auth only; agent keys answer `403`):
  - `GET /api/notifications` (`?unreadOnly=true|false`, `?limit=1..100`, `?cursor=...`) → `{ items, unreadCount, nextCursor }`, filtering out revoked project access, suspended memberships, deactivated humans, and trashed issues (`issues.deleted_at IS NULL`). Each item includes `id`, `kind`, `summary`, `readAt`, `createdAt`, `project: { id, key, name, workspaceId }`, `issue: { id, number, key, title }`.
  - `POST /api/notifications/:notificationId/read` → idempotently sets `read_at = COALESCE(read_at, statement_timestamp())`; returns `404` if not found, not owned by caller, or no longer accessible.
  - `POST /api/notifications/read-all` → marks all currently accessible unread notifications for the caller read and returns `{ markedCount }`.
- **Retention**: hourly maintenance sweep prunes notifications with `read_at < now() - interval '90 days'` or `created_at < now() - interval '180 days'`.
- **Web UI**: add `Notifications` (`/notifications`) to the main sidebar in `apps/web/src/routes/__root.tsx` with an unread badge polled every 15s via TanStack Query. Clicking an item calls mark-read and navigates to `/issues/$issueId`.

### Outgoing webhooks (`apps/server/src/features/webhooks/`)

- **Schema**:
  - `webhooks`: `id` (`text` PK), `workspace_id` (`text` FK → `workspaces.id`), `url` (`text` CHECK `^https?://`), `description` (`text` default `""`), `secret_encrypted` (`text` NOT NULL, AES-256-GCM via `platform/secrets.ts`), `all_projects` (`boolean` NOT NULL DEFAULT `true`), `all_events` (`boolean` NOT NULL DEFAULT `true`), `events` (`text[]` NOT NULL DEFAULT `'{}'`), `enabled` (`boolean` NOT NULL DEFAULT `true`), `consecutive_failures` (`integer` NOT NULL DEFAULT `0` CHECK `>= 0`), `disabled_at` (`timestamptz`), `disabled_reason` (`text`), `created_by_human_id` (`text` FK → `humans.id`), `updated_by_human_id` (`text` FK → `humans.id`), `created_at`, `updated_at`.
  - `webhook_projects`: composite PK `(webhook_id, project_id)` with `webhook_id` FK → `webhooks.id` (`ON DELETE CASCADE`) and `project_id` FK → `projects.id` (`ON DELETE CASCADE`). When `transfers` moves a project out of a workspace, delete matching rows from `webhook_projects` for the source workspace's webhooks inside the transfer transaction; `all_projects` remains `false`, preventing accidental scope widening.
  - `webhook_deliveries`: `id` (`text` PK), `webhook_id` (`text` FK → `webhooks.id` `ON DELETE CASCADE`), `event` (`text` NOT NULL — `ProjectActivityType` or `'webhook.test'`), `activity_id` (`text` FK → `project_activity.id` nullable for `webhook.test`), `payload` (`jsonb` NOT NULL), `status` (`text` CHECK in `'pending' | 'delivering' | 'delivered' | 'failed'`), `attempt_count` (`integer` NOT NULL DEFAULT `0`), `next_attempt_at` (`timestamptz` NOT NULL DEFAULT `now()`), `locked_until` (`timestamptz`), `last_status_code` (`integer`), `last_duration_ms` (`integer`), `last_error` (`text`, truncated to 512 chars), `delivered_at` (`timestamptz`), `created_at` (`timestamptz` NOT NULL DEFAULT `now()`). Index on `(status, next_attempt_at)` and `(webhook_id, created_at DESC)`.
- **Authorization & limits**:
  - Human `Workspace owner` (shared workspace) or personal owner (`Personal workspace`) only. Agents and non-owner members receive `403`; non-members receive `404`.
  - Enforce a cap of 20 webhooks per workspace (`409 webhook_limit_reached`).
  - Creating or rotating a webhook requires `ORRERY_ENCRYPTION_KEY` (`409 encryption_key_missing`, matching ADR-0004). Signing secrets (`whsec_<32-byte base64url>`) are returned only in the create and rotate responses and never stored in plaintext or logged.
- **REST contract**:
  - `GET /api/workspaces/:workspaceId/webhooks`
  - `POST /api/workspaces/:workspaceId/webhooks` (returns webhook + one-time `signingSecret`)
  - `PATCH /api/workspaces/:workspaceId/webhooks/:webhookId` (update `url`, `description`, `allProjects`, `projectIds`, `allEvents`, `events`, `enabled`; re-enabling clears `disabledAt`, `disabledReason`, and `consecutiveFailures`)
  - `POST /api/workspaces/:workspaceId/webhooks/:webhookId/rotate-secret` (returns one-time `signingSecret`)
  - `DELETE /api/workspaces/:workspaceId/webhooks/:webhookId`
  - `POST /api/workspaces/:workspaceId/webhooks/:webhookId/test` (enqueues a `webhook.test` delivery that does not increment `consecutive_failures`)
  - `GET /api/workspaces/:workspaceId/webhooks/:webhookId/deliveries` (latest 50 deliveries)
- **Envelope, signing, SSRF guard & delivery worker**:
  - Enqueue matching deliveries in the same Postgres transaction as `project_activity` (matching `enabled = true`, `all_projects OR project_id IN webhook_projects`, `all_events OR type = ANY(events)`).
  - Payload envelope (`version: 1`): `{ id, version: 1, event, occurredAt, workspaceId, project: { id, key, name }, issue: { id, number, key, title, status } | null, knowledgeEntry: { id, title } | null, actor: { kind, id, displayName }, summary }`.
  - Headers: `Content-Type: application/json; charset=utf-8`, `User-Agent: Orrery-Webhooks/1`, `X-Orrery-Delivery`, `X-Orrery-Event`, `X-Orrery-Timestamp` (Unix seconds), `X-Orrery-Signature-256: sha256=<hex HMAC-SHA256 of "${timestamp}.${rawBody}">`.
  - Worker polls every 2 seconds (plus wakes immediately on local enqueue), claims batches of up to 20 due rows with `FOR UPDATE SKIP LOCKED` (and reclaims any `delivering` row whose `locked_until < now()` after a crash), uses a 10-second `AbortSignal.timeout(10_000)`, disables redirects (`redirect: "manual"`), and resolves/pins DNS via a custom lookup that rejects loopback, RFC 1918, CGNAT, link-local/metadata, ULA, unspecified, multicast, and IPv4-mapped IPv6 addresses unless `ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=true` (which also permits `http://`).
  - Backoff schedule for attempts 1–5: immediate, `+30s`, `+2m`, `+10m`, `+30m`. Non-`2xx` / timeout / network / SSRF / `webhook_secret_unreadable` errors retry until attempt 5 marks `failed`. When a non-test delivery transitions to `failed`, atomically increment `webhooks.consecutive_failures`; reaching `10` sets `enabled = false`, `disabled_at = now()`, `disabled_reason = 'consecutive_failures'`.
  - Hourly maintenance sweep deletes `webhook_deliveries` older than 30 days.
- **Web UI**: add a `Webhooks` tab to `/workspaces/$workspaceId` (visible only when `workspace.isOwner`) with create/edit drawer, one-time signing secret copy banner, enable/disable toggle with auto-disabled reason badge, rotate secret, delete confirmation, `Send test` action, and recent deliveries table.

### Docs and release packaging

- Add [docs/guides/install.md](../guides/install.md), [docs/guides/backup-and-restore.md](../guides/backup-and-restore.md), and [docs/guides/connect-agent.md](../guides/connect-agent.md) following `docs/writing-docs.md`.
- Update `README.md` and `docs/README.md` so status badges, roadmap checkboxes, and guide links accurately reflect shipped M0–M4 + M6 features.
- In `.github/workflows/ci.yml`, keep `ghcr.io/forge-orbit/orrery` as the sole container registry and add a `release` job gated on `startsWith(github.ref, 'refs/tags/v')` (`needs: [publish]`, `permissions: { contents: write }`) using `gh release create` with `--generate-notes` and the GHCR pull command.

## Testing Decisions

- **Real-Postgres service tests**:
  - Sweeper + `issue_session_expired`: lapsed 5-minute lease creates `issue_session_expired` activity, reverts `in_progress → todo`, and creates a `session_expired` notification; concurrent sweep + hot-path call emits exactly one activity and one notification.
  - Notifications: recipient resolution for `handoff` (assignee vs. unassigned creator fallback + agent owner, excluding self), `needs_input` (`asked` and `paused`), and `session_expired`; live exclusion after project access revocation, membership suspension, or moving an issue to Trash; agent key receives `403`; idempotent `read` and `read-all`; 90/180-day pruning.
  - Webhooks: owner-only RBAC (`403` for members/agents, `404` for non-members); `409 encryption_key_missing` without `ORRERY_ENCRYPTION_KEY`; secret encrypted at rest and never leaked in responses/logs; `all_projects = false` does **not** widen when its last project is transferred out; SSRF guard blocks `127.0.0.1`, `169.254.169.254`, `10.x`, `::1`, `::ffff:127.0.0.1`, `http://`, and `302` redirects when `ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=false`; real local HTTP receiver test verifies HMAC-SHA256 signature, retry backoff on `500`, `2xx` success resetting `consecutive_failures`, auto-disable after 10 consecutive exhausted deliveries, and `webhook.test` delivery.
- **Black-box e2e & Playwright browser tests**:
  - Notifications end-to-end: agent hands off issue / asks question → human sees unread badge in sidebar, opens `/notifications`, clicks item to mark read and navigate to issue, and uses `Mark all read`.
  - Webhooks end-to-end: with `ORRERY_WEBHOOK_ALLOW_PRIVATE_URLS=true` in the e2e stack, workspace owner creates a webhook pointing to a local test HTTP listener, triggers `Send test` and an issue handoff, verifies signed JSON envelope receipt and delivery log in the Workspace `Webhooks` tab, and verifies `scripts/check-e2e-logs.mjs` finds no signing secret in container logs.
  - Backup & restore verification: run the exact `pg_dump` / `pg_restore` sequence from `docs/guides/backup-and-restore.md` against the Compose Postgres service to confirm clean round-trip recovery.

## Out of Scope

- Email or Slack notifications beyond the existing Needs-input email (deferred post-MVP).
- Per-project notification preference matrices, mute/snooze, `@mention` parsing, or comment/assignment notifications.
- GitHub App auto-linking or bidirectional PR status sync.
- Docker Hub publishing (GHCR only for MVP).
- Deep feature walkthrough guides (*Workspaces & people*, *Projects & issues*, *Agents panel & inbox*, *MCP tool reference*) and the M5 vault guide.

## Further Notes

- Spec for [#7 — \[MVP\] M6: Release polish (notifications, PR links, setup docs)](https://github.com/forge-orbit/orrery/issues/7).
- Domain terms (`Notification`, `Webhook`) are recorded in [GLOSSARY.md](../../GLOSSARY.md); webhook scoping, outbox, and security decisions are recorded in [ADR-0007](../adr/0007-outgoing-webhooks-outbox-and-security.md).
- Natural implementation slices for ticketing:
  1. Proactive expiry sweeper + `issue_session_expired` activity + In-app notifications backend (`notifications` feature, REST, tests)
  2. Outgoing webhooks backend (`webhooks` feature, outbox worker, SSRF guard, transfer cleanup, REST, tests)
  3. M6 Web UI (`/notifications` + sidebar badge, Workspace `Webhooks` tab + delivery inspector, Playwright e2e)
  4. Operator & agent docs (`install.md`, `backup-and-restore.md`, `connect-agent.md`, `README.md` / `docs/README.md` refresh) + GitHub Release CI job
