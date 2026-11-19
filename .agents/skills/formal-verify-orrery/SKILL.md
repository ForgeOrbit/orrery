---
name: formal-verify-orrery
description: Formally model-check Orrery's stateful server invariants (workspace ownership & locks, workspace/installation invitation lifecycles, concurrent project issue/knowledge updates, email verification token rotation, bootstrap singleton, and workspace non-enumeration) via exhaustive BFS state-space exploration. Use before merging any change to apps/server/src/features/{accounts,invitations,projects,settings,workspaces}/service.ts or db/migrations/0007..0008, or when asked to formally verify Orrery.
---

# Formal Verify Orrery

Exhaustive finite-state model checking for Orrery's highest-stakes concurrency, lifecycle, and access-boundary invariants. The checker extracts the active locks and transition guards directly from Orrery's server source and SQL migrations, then runs a breadth-first search (BFS) over all reachable concurrent interleavings to verify safety and liveness properties.

## Sync Commit & Coverage Record

- **Last verified commit:** `1d677e9`
- **Check whether a change touches verified code:**
  ```bash
  git diff --name-only 1d677e9 -- \
    apps/server/src/features/workspaces/service.ts \
    apps/server/src/features/projects/service.ts \
    apps/server/src/features/invitations/service.ts \
    apps/server/src/features/accounts/service.ts \
    apps/server/src/features/settings/service.ts \
    db/migrations/0007_workspace_owner_guards.sql \
    db/migrations/0008_workspace_ownership_write_order.sql
  ```
  If that command prints any file, run the verifier below before declaring the change done. Move the sync commit forward **only** after confirming the model in `scripts/verify.py` still accurately reflects the code at the new commit.

## Run the Check

One command, zero external dependencies (requires only Python 3.10+, runs in `< 0.3s`):

```bash
python3 .agents/skills/formal-verify-orrery/scripts/verify.py
```

For machine-readable output (extracted code facts + counterexample traces):

```bash
python3 .agents/skills/formal-verify-orrery/scripts/verify.py --json
```

Exit code `0` means every property passed; exit code `1` means at least one property failed and its shortest counterexample trace was printed in Orrery's own function names.

## Tool Choice

We use a **zero-dependency Python 3 exhaustive BFS model checker** paired with source-guard extraction rather than TLA+/TLC or Quint because:
1. Neither a JVM/TLC nor Quint is installed on the dev environment or CI by default, while `python3` is always available.
2. Source-guard extraction binds the model directly to the live TypeScript and SQL files, so removing a lock or guard (e.g., dropping `.for("update")` or `lockWorkspaceForMutation`) immediately switches the model to the unguarded transition relation and produces the real counterexample trace.
3. If you author a new TLA+ specification for a future subsystem (e.g., #27 project permissions or #38 account deactivation), read its output with `/statechart`.

## Verified Properties, Bounds & Harm

| ID | Files & Functions | Plain-English Property | Harm Prevented | Bounds |
| --- | --- | --- | --- | --- |
| **M1** | `workspaces/service.ts` (`removeMember`, `appointOwner`), `0007`, `0008` | Every shared workspace always retains at least one owner. | Ownerless shared workspace that nobody can administer. | 3 humans (`u1`, `u2`, `u3`), 2 concurrent writers (10,450 states). |
| **M2a** | `workspaces/service.ts` (`invite`, `redeemWorkspaceInvitation`) | A failed SMTP delivery never locks an email out of being re-invited for 7 days. | Dead invitation state where recipient cannot redeem and owner cannot resend. | 1 workspace, 1 email, SMTP success/fail + redemption. |
| **M2b** | `workspaces/service.ts` & `invitations/service.ts` (`recordDelivery`) | An already-accepted invitation is never stamped `delivery_status = 'failed'`. | Contradictory audit trail (`accepted` + `failed`). | 1 in-flight delivery racing 1 redemption. |
| **M3** | `invitations/service.ts` (`inviteInstallation`), `accounts/service.ts` (`createInvitedHuman`) | No fresh pending installation invitation is committed after the email already has an account. | Unredeemable invitation emailed to an existing user. | 1 admin invite racing 1 concurrent registration on the same email. |
| **M4** | `projects/service.ts` (`updateIssue`, `updateKnowledge`) | Concurrent `PATCH`es preserve both edits, keep `project_activity` consistent with `issue.status`, and emit at most one `issue_closed` event. | Silent lost updates, activity-feed lies, and duplicate close events. | 3 concurrent `PATCH`es (close + edit title + close) under `READ COMMITTED`. |
| **M5** | `settings/service.ts` (`sendTestEmail`) | Settled `200 OK` test-email calls leave a live redeemable verification token. | Admin receives a `200 OK` email whose token was already deleted. | 2 concurrent `sendTestEmail` calls for one admin. |
| **M6** | `accounts/service.ts` (`setupAdmin`) | Concurrent bootstrap attempts create at most one administrator and one personal workspace. | Multiple bootstrap admins or half-bootstrapped installation. | 2 concurrent `setupAdmin` requests. |
| **M7** | `workspaces/service.ts` (`requireOwner`) | Non-members receive `404 workspace_not_found` (never `403`) on all shared-workspace endpoints. | Workspace-ID enumeration oracle across owner endpoints. | All 5 shared-workspace endpoints probed by a non-member. |

## What Is Not Covered

- **SQL/Drizzle runtime semantics & deadlocks across unrelated tables**: The model checks the extracted design and lock ordering, not PostgreSQL's query planner or migration SQL syntax. Always pair this skill with `pnpm test` (real Postgres via Testcontainers) and `/verify-orrery` for end-to-end runtime proof.
- **UI & HTTP transport**: Cookie flags, Zod validation, and React state are outside this model; cover them with `pnpm check`, `pnpm test`, and `/verify-orrery`.
- **Unbounded actor counts**: M1 is bounded to 3 humans / 2 concurrent writers; M4 is bounded to 3 concurrent `PATCH`es.

## Interpreting Failures & Maintaining the Skill

- **Real bug vs. modeling error:** Open the files listed in the failing check's output. If a lock, guard, or SQL predicate was removed or reordered, the counterexample trace shows a real bug — fix the product code and add a real-Postgres regression test. If the product code was intentionally refactored to enforce the same invariant via a *different* mechanism (e.g., a new DB constraint or different helper name) so `extract_code_facts()` no longer recognizes it, update `extract_code_facts()` and the transition model in `scripts/verify.py` to match the new mechanism, prove it still fails when the mechanism is broken, and advance the sync commit above.
- Use `/maintain-formal-verification-skill` whenever covered files have drifted past the sync commit.
