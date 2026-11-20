# Agent API and sessions (workflow transitions, telemetry, and v1 activity blocks)

Product and engineering decisions are agreed for M3 ([#4](https://github.com/forge-orbit/orrery/issues/4)), building on [Identity, workspaces, and agent work sessions](./mvp-spec.md), [Agent board interaction](./agent-board-interaction.md), and [Projects and issues](./projects-and-issues.md).

## Problem Statement

Core runs, five-minute claim leases, subagent attribution, stop signals (#82), ephemeral session activities (#83), and agent assignment (#84) are already specified, but three M3 session behaviors remain open:
1. Work-session claim, release, lease expiry, question resolution, and completion do not yet drive the six-state issue workflow (`backlog`, `todo`, `in_progress`, `review`, `done`, `cancelled`).
2. Harnesses and agents have no way to report optional token usage and execution cost on work sessions.
3. Ephemeral session activities (`work_session_activities.detail`) lack a versioned contract schema for structured v1 blocks (`key_value`, `table`, `checklist`, `test_results`).

## Solution

Extend the work-sessions and MCP/REST agent API with:

- Automatic, atomic issue-state transitions tied to work-session claim, release, lease expiry, question resolution, and completion outcome (`"review" | "done"`, defaulting to `"review"` handoff; see [ADR-0005](../adr/0005-issue-workflow-and-derived-needs-input.md)).
- Independent subtask eligibility in `list_ready_work`.
- Optional, cumulative `input_tokens`, `output_tokens`, and `cost_usd_micros` fields on work sessions.
- A versioned `v1` discriminated union for `work_session_activities.detail.block` (`key_value`, `table`, `checklist`, `test_results`) in the shared contract, while continuing to accept arbitrary JSON objects in `detail`.

## User Stories

### Workflow transitions and ready work

1. As an agent, I want `list_ready_work` to return only non-deleted `todo` issues that are not in `needs_input`, have no active work session, have no open non-deleted blockers, and are unassigned or assigned to me, so that I never claim untriaged `backlog` or blocked work.
2. As an agent, I want one-level subtasks in `todo` to appear independently in `list_ready_work`, so that I can claim and complete subtasks just like top-level issues.
3. As an agent, I want claiming a `todo` issue to atomically transition it to `in_progress`, so that the board immediately reflects active work.
4. As a human member, I want releasing a claim or letting a five-minute lease expire to revert an `in_progress` issue back to `todo`, so that unclaimed work never stays stranded in `in_progress`.
5. As a human member, I want an issue paused in `needs_input` (or whose claim lapsed while waiting on a question) to remain excluded from `list_ready_work` until a human answers, and to be in `todo` once answered with no active session, so that it returns cleanly to the ready queue after the blocker is answered.
6. As an agent, I want completing a work session to default to `outcome: "review"` (handoff), so that a human is prompted to review my work before closing it.
7. As an authorized agent (`Contribute` or `Manage`), I want to optionally pass `outcome: "done"` when completing a work session, so that routine tasks can be closed directly without mandatory human review.

### Token usage and cost telemetry

8. As an agent or harness, I want to optionally report cumulative `input_tokens`, `output_tokens`, and `cost_usd_micros` during work-session heartbeat, progress, or completion, so that teams can inspect session cost without double-counting on network retries.
9. As a human member, I want unreported token and cost fields kept `null`, so that the API never synthesizes or estimates missing telemetry.

### Structured v1 activity detail blocks

10. As an agent, I want to pass a validated `v1` block (`key_value`, `table`, `checklist`, or `test_results`) inside a session activity's `detail.block` field over MCP and REST, so that test runs, checklists, and metrics are stored in a predictable schema.
11. As an agent, I want arbitrary JSON objects in `detail` to remain accepted when `detail.block` is omitted, so that custom harness telemetry is never rejected.

## Implementation Decisions

### Session-driven workflow transitions

- Update `list_ready_work` to filter for `status = 'todo'`, `deleted_at IS NULL`, `needs_input = false`, no active work session, no non-deleted blocker with `status NOT IN ('done', 'cancelled')`, and assignee either null or matching the calling agent. Subtasks with `parent_issue_id IS NOT NULL` are included by the same rules.
- When an agent claims an issue (`status = 'todo'`), atomically set `status = 'in_progress'` in the same transaction.
- Whenever a work session ends without completion — via explicit release, five-minute lease expiry, or one-hour question pause (`require_human`) — if the issue's `status` is `in_progress`, revert `status` to `todo` in the same update. While `needs_input` is `true`, the issue remains excluded from `list_ready_work` and surfaces in Needs input; once a human answers the question (`needs_input` becomes `false`), the issue is already in `todo` and immediately eligible for `list_ready_work` without ever sitting stranded in `in_progress` with no active worker.
- Extend work-session completion (`complete` over REST and MCP) with an optional `outcome: "review" | "done"` parameter (default `"review"`):
  - `"review"` transitions the issue to `review` (`closed_at = NULL`) and records a handoff activity event in `project_activity`.
  - `"done"` transitions the issue to `done` (`closed_at = now()`) and records an issue-closed activity event (requiring `Contribute` or `Manage` on the project).

### Token usage and cost fields

- Add nullable integer columns `input_tokens`, `output_tokens`, and `cost_usd_micros` to `work_sessions`, each with a database CHECK constraint requiring `>= 0` when non-null.
- Accept optional `inputTokens`, `outputTokens`, and `costUsdMicros` fields on work-session heartbeat/renew, progress report, and completion requests in the shared contract (REST and MCP).
- Treat reported values as **cumulative session totals** (idempotent overwrite on retry; omitting a field leaves its current stored value unchanged).

### Versioned v1 activity block contract

- In the shared contract for `work_session_activities.detail`, define an optional `block` schema as a `v1` discriminated union on `type` (with `version: z.literal(1)`):
  - `key_value`: list of `{ key, value }` string pairs.
  - `table`: `{ columns: string[], rows: string[][] }`.
  - `checklist`: list of `{ label: string, checked: boolean }`.
  - `test_results`: `{ passed: number, failed: number, skipped?: number, cases?: { name: string, status: "passed" | "failed" | "skipped", message?: string }[] }`.
- Keep `detail` accepting any JSON object when `block` is absent so existing and custom callers remain compatible.

## Testing Decisions

- **Real-Postgres service tests**:
  - Claiming moves `todo → in_progress`; release, 5-minute lease expiry, and 1-hour `require_human` question pause revert `in_progress → todo`; answering a paused question clears `needs_input` and makes the `todo` issue immediately visible in `list_ready_work` (verifying no reachable state leaves a live issue in `in_progress` without an active session).
  - Completion outcomes: default handoff transitions `in_progress → review` (`closed_at` null); `"done"` transitions `in_progress → done` (`closed_at` set, unblocking dependents).
  - Independent subtask claiming in `list_ready_work`.
  - Cumulative token and cost overwrites: idempotent on repeated calls, rejects negative numbers, preserves `null` when omitted.
  - `detail.block` v1 schema validation for all four block types plus arbitrary JSON passthrough.
- **Black-box e2e tests (REST + MCP)**:
  - Full agent loop over MCP: `list_ready_work` → `claim` → `report_progress` / activity with `v1` `test_results` block and token/cost totals → `complete` (default `"review"` and explicit `"done"`).

## Out of Scope

- Server-side agent orchestration, webhooks, or `@mention` comment triggers.
- Automatic cost computation from model pricing tables (Orrery records only what the client reports).
- Custom plugin block schemas beyond the four built-in `v1` block types.

## Further Notes

- Spec for [#4 — \[MVP\] M3: Agent API and sessions (MCP + REST, claim leases)](https://github.com/forge-orbit/orrery/issues/4).
