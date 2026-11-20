---
name: formal-verify-orrery
description: Formally model-check Orrery's stateful server invariants (workspace ownership & locks, workspace/installation invitation lifecycles, concurrent project issue/knowledge updates, email verification token rotation, bootstrap singleton, workspace non-enumeration, #28 permission delegation with inviter authority, #30 workspace-scoped agent API keys, and #33 agent project work over MCP with REST/MCP denial parity, agent actor attribution, and no agent access to membership or administration) via exhaustive BFS state-space exploration. Use before merging any change to apps/server/src/features/{accounts,agents,invitations,projects,settings,workspaces}/service.ts, apps/server/src/features/agents/mcp.ts, packages/contract/src/mcp-tools.ts, apps/server/src/db/schema.ts, or db/migrations/0007..0008,0012..0017, or when asked to formally verify Orrery.
---

# Formal Verify Orrery

Exhaustive finite-state model checking for Orrery's highest-stakes concurrency, lifecycle, and access-boundary invariants. The checker extracts the active locks and transition guards directly from Orrery's server source and SQL migrations, then runs a breadth-first search (BFS) over all reachable concurrent interleavings to verify safety and liveness properties.

## Sync Commit & Coverage Record

- **Last verified commit:** `c6c2748`
- **Check whether a change touches verified code:**
  ```bash
  git diff --name-only 7fa5d0c -- \
    apps/server/src/features/workspaces/service.ts \
    apps/server/src/features/projects/service.ts \
    apps/server/src/features/invitations/service.ts \
    apps/server/src/features/accounts/service.ts \
    apps/server/src/features/agents/service.ts \
    apps/server/src/features/agents/mcp.ts \
    apps/server/src/features/projects/rest.ts \
    packages/contract/src/mcp-tools.ts \
    apps/server/src/db/schema.ts \
    apps/server/src/features/settings/service.ts \
    db/migrations/0007_workspace_owner_guards.sql \
    db/migrations/0008_workspace_ownership_write_order.sql \
    db/migrations/0012_project_access_scope.sql \
    db/migrations/0013_numerous_doorman.sql \
    db/migrations/0014_backfill_expired_invitation_timestamps.sql \
    db/migrations/0015_married_human_fly.sql \
    db/migrations/0016_clumsy_masked_marvel.sql \
    db/migrations/0017_rapid_talon.sql
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
| **M3** | `invitations/service.ts` (`inviteInstallation`, `resendInstallation`, `registerInstallation`), `accounts/service.ts` (`createInvitedHuman`) | No fresh pending installation invitation is committed after the email already has an account. | Unredeemable invitation emailed to an existing user. | 1 admin invite or resend racing 1 registration on the same email; registration can win first. |
| **M4** | `projects/service.ts` (`updateIssue`, `updateKnowledge`) | Concurrent `PATCH`es preserve both edits, keep `project_activity` consistent with `issue.status`, and emit at most one `issue_closed` event. | Silent lost updates, activity-feed lies, and duplicate close events. | 3 concurrent `PATCH`es (close + edit title + close) under `READ COMMITTED`. |
| **M5** | `settings/service.ts` (`sendTestEmail`) | Settled `200 OK` test-email calls leave a live redeemable verification token. | Admin receives a `200 OK` email whose token was already deleted. | 2 concurrent `sendTestEmail` calls for one admin. |
| **M6** | `accounts/service.ts` (`setupAdmin`) | Concurrent bootstrap attempts create at most one administrator and one personal workspace. | Multiple bootstrap admins or half-bootstrapped installation. | 2 concurrent `setupAdmin` requests. |
| **M7** | `workspaces/service.ts` (`readMembership`, `requireOwner`, `requireInviter`, and the actor lookup in `members`, `invite`, `invitations`, `resendInvitation`, `revokeInvitation`, `appointOwner`, `updateMemberCapability`, `removeMember`) | Non-members receive `404 workspace_not_found` (never `403`) on every shared-workspace endpoint. | Workspace-ID enumeration oracle across owner, delegation, and invitation endpoints. | All 10 shared-workspace endpoints probed by a non-member (10 states). |
| **M8** | `projects/service.ts` (`setProjectAccess`, `removeProjectAccess`, `revokeMemberProjectAccess`), `workspaces/service.ts` (`removeMember`), `0012` | No orphaned project grant survives a concurrent member removal. | A removed member's old project access reviving on rejoin. | 1 member, 1 grant, grant/remove race. |
| **M9** | `workspaces/service.ts` (`invite`, `resendInvitation`, `redeemWorkspaceInvitation`, `acceptInvitation`, `registerThroughInvitation`), `projects/service.ts` (`applyInvitationGrantsInTransaction`) | Under the atomic-transition assumption, valid scope survives resend, stale scope is not previewed, rotated, or granted, and an older offer cannot be resent after its recipient joins. | A stale invitation creating cross-workspace access, or a resend silently dropping the offered scope. | 1 offer, invited/other project workspace, 2 acceptance paths, 0–1 resend. |
| **M10** | `workspaces/service.ts` (`updateMemberCapability`, `removeMember`, `invite`, `invitations`, `resendInvitation`, `revokeInvitation`, `requireProjectManageScope`, `requireInviterStillAuthorized`, `redeemWorkspaceInvitation`, `acceptInvitation`, `registerThroughInvitation`) | Only owners appoint or remove permission managers; a manager cannot modify an owner, themselves, or a capability they lack; a delegated remover cannot remove an owner or permission manager; a delegated inviter may offer only projects they Manage, sees only offers within that scope, and can revoke their own offer after losing Manage; a dead pending offer is superseded rather than blocking an address; a pending offer fails at both redemption paths once the inviter's capability, membership, verified email, or project Manage is withdrawn. | Uncontrolled spread of permission management, delegated removal of protected members, leaked unshared project offers, seven-day re-invite deadlocks, and stale invitations creating access after authority was revoked. | 28 bounded attempts (22 refusals, 6 positive controls), 29 states. |
| **M11** | `agents/service.ts` (`resolveKeyInTransaction`, `issueKey`, `revokeInTransaction`, `ownerRevokeKey`, `recordEvent`), `projects/service.ts` (`projectAccessCeilingInTransaction`, `projectAccessAtLeast`), `db/schema.ts` (`agents`, `agentApiKeys`, `agentApiKeyProjects`, `agentKeyEvents`), `0016` | A key authenticates only in its one workspace and only while its human owner can still use that workspace; revocation and expiry (except for Never) also refuse it; Never still obeys revocation, membership, and the human owner's *current* project access, so a lowered level caps the agent and a removed grant ends its access; issuance cannot exceed the human's current level; a workspace owner can revoke only keys scoped to their workspace; retries write no second revocation event, and no event or stored row carries the secret. | A credential spilling across workspaces, an old key keeping removed or promoted authority, an owner revoking a human's keys elsewhere, duplicate audit events, or an audit trail leaking a secret. | 17 bounded attempts (9 refusals, 3 positive controls, 5 state outcomes), 18 states. |
| **M12** | `projects/service.ts` (`requireLevel`, `actorAccessLevel`, `recordActivity`), `projects/rest.ts` (`humanActor`), `agents/mcp.ts` (`createAgentsMcp`), `contract/mcp-tools.ts`, `db/schema.ts`, `0017` | REST and MCP use one access gate; a Contribute key can do the issue/knowledge cycle and a Read key can inspect but cannot change work with the same stable denial code; an agent's level is its key's effective grant in the key's one workspace, re-authenticated on every tool call; writes and activity rows name the agent (exactly one human-or-agent actor), and neither transport offers membership, access administration, or installation settings to a key. | A Read key changing work, a REST/MCP denial mismatch, a key acting in another workspace, a revoked or demoted key surviving on an open connection, agent work misattributed to its human owner, or an agent reaching membership/administration tools. | 18 bounded attempts (8 refusals, 4 positive controls, 6 outcomes), 19 states. |

## What Is Not Covered

- **SQL/Drizzle runtime semantics & deadlocks across unrelated tables**: The model checks the extracted design and lock ordering, not PostgreSQL's query planner or migration SQL syntax. Always pair this skill with `pnpm test` (real Postgres via Testcontainers) and `/verify-orrery` for end-to-end runtime proof.
- **UI & HTTP transport**: Cookie flags, Zod validation, and React state are outside this model; cover them with `pnpm check`, `pnpm test`, and `/verify-orrery`.
- **Unbounded actor counts**: M1 is bounded to 3 humans / 2 concurrent writers; M4 is bounded to 3 concurrent `PATCH`es.
- **M9 transaction boundary**: M9 is a bounded design model driven by source markers. It assumes atomic transitions; it cannot prove that token, account, membership, and grant writes use the same transaction or roll back together. The real-Postgres workspaces tests check both successful acceptance paths and verify database state after a stale-scope rejection.
- **Project transfer (#46)**: M9 models a project moving out of the invited workspace before redemption, but not the transfer operation itself. Use the scoped invitation recipe in `verify-orrery/features/workspaces.md` for REST and browser checks.
- **M10 transaction boundary and concurrency**: M10 enumerates independent authority decisions in a bounded design model; it does not explore interleavings between two capability changes and a redemption, and it assumes the rejected `inviter_not_authorized` path rolls back the token and every earlier write in the transaction. Real-Postgres tests in `workspaces.test.ts` assert the invitation stays pending and no membership, account, or project grant commits. The live REST recipe in `verify-orrery/features/workspaces.md` covers the same ceilings through HTTP.
- **M11 transaction boundary and revocation races**: M11 enumerates independent key decisions in a bounded design model; it does not explore an authentication transaction interleaved with a revocation, a membership removal, or a project-grant change, and it assumes the rejected paths write no key or event. The real-Postgres `agents.test.ts` proves the just-before/just-after expiry boundary in database time, the issuance ceiling, the lowered/removed grant ceiling, immediate refusal after workspace removal, idempotent revocation, owner-revocation isolation, and the audit rows. The black-box `zz-agents.spec.ts` proves the same HTTP outcomes against the running image, including human self-revocation.
- **M12 transport and attribution boundaries**: M12 is a bounded design model driven by source markers. It checks that the tool set and the two adapters call the one service gate and that the actor columns/constraints exist; it does not replay MCP frames or prove a particular HTTP status. The real-Postgres `agents.test.ts` proves agent attribution in stored rows and activity, Read-vs-Contribute denials, dynamic human-access capping, workspace/project scoping, and REST denial parity. The black-box `zz-mcp.spec.ts` drives the actual MCP protocol client against the built image for the same flows, including tool-list exposure, out-of-scope, and revoked keys.

## Interpreting Failures & Maintaining the Skill

- **Real bug vs. modeling error:** Open the files listed in the failing check's output. If a lock, guard, or SQL predicate was removed or reordered, the counterexample trace shows a real bug — fix the product code and add a real-Postgres regression test. If the product code was intentionally refactored to enforce the same invariant via a *different* mechanism (e.g., a new DB constraint or different helper name) so `extract_code_facts()` no longer recognizes it, update `extract_code_facts()` and the transition model in `scripts/verify.py` to match the new mechanism, prove it still fails when the mechanism is broken, and advance the sync commit above.
- Use `/maintain-formal-verification-skill` whenever covered files have drifted past the sync commit.
