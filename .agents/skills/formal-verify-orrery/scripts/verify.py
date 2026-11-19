#!/usr/bin/env python3
"""
Orrery Formal Verification Model Checker (M1-M10).

Extracts critical concurrency, locking, and state-transition guards directly from
Orrery's server source and SQL migrations, then runs an exhaustive BFS finite-state
model checker over each subsystem to verify safety and liveness invariants.

Usage:
  python3 .agents/skills/formal-verify-orrery/scripts/verify.py
  python3 .agents/skills/formal-verify-orrery/scripts/verify.py --json
"""

from collections import deque
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[4]


@dataclass
class CheckResult:
    id: str
    model: str
    property_name: str
    kind: str  # "safety" | "liveness"
    status: str  # "verified" | "violated"
    states_explored: int
    transitions_explored: int
    summary: str
    counterexample: list[str]
    files: list[str]


def read_text(rel_path: str) -> str:
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def slice_between(text: str, start_marker: str, end_marker: str | None = None) -> str:
    idx = text.find(start_marker)
    if idx == -1:
        return ""
    sub = text[idx:]
    if end_marker is not None:
        end_idx = sub.find(end_marker, len(start_marker))
        if end_idx != -1:
            return sub[:end_idx]
    return sub


def extract_code_facts() -> dict[str, Any]:
    """Read real Orrery source files to determine which guards are currently active."""
    ws_src = read_text("apps/server/src/features/workspaces/service.ts")
    proj_src = read_text("apps/server/src/features/projects/service.ts")
    inv_src = read_text("apps/server/src/features/invitations/service.ts")
    acc_src = read_text("apps/server/src/features/accounts/service.ts")
    set_src = read_text("apps/server/src/features/settings/service.ts")
    mig_0007 = read_text("db/migrations/0007_workspace_owner_guards.sql")
    mig_0008 = read_text("db/migrations/0008_workspace_ownership_write_order.sql")

    # M1: Workspace ownership serialization + deferred trigger
    remove_member_fn = slice_between(ws_src, "async removeMember(", "  };")
    m1_lock_in_service = "lockWorkspaceForMutation(tx, workspaceId)" in remove_member_fn
    m1_last_owner_check = 'throw new WorkspacesError("last_owner")' in remove_member_fn
    m1_db_advisory_lock = "pg_advisory_xact_lock(61683814, 24)" in mig_0008
    m1_db_trigger = "ensure_shared_workspace_has_owner()" in mig_0007

    # M2a: Replacing a failed, still-live invitation revokes it rather than expiring it.
    invite_fn = slice_between(ws_src, "async invite(", "    // Every invitation in this workspace")
    revoke_failed = slice_between(invite_fn, "status: InvitationStatus.enum.revoked", "await tx.insert(workspaceInvitations)")
    m2a_supersedes_failed = (
        "InvitationDelivery.enum.failed" in revoke_failed
        and "revokedAt" in revoke_failed
        and "gt(workspaceInvitations.expiresAt" in revoke_failed
    )

    # M2b: recordDelivery guarded by status='pending' in both workspaces and invitations
    ws_record_delivery = slice_between(ws_src, "async function recordDelivery(", "async function redeemWorkspaceInvitation(")
    inv_record_delivery = slice_between(inv_src, "async function recordDelivery(", "export interface InvitationsServiceDeps")
    m2b_ws_guarded = "eq(workspaceInvitations.status, InvitationStatus.enum.pending)" in ws_record_delivery
    m2b_inv_guarded = "eq(invitations.status, InvitationStatus.enum.pending)" in inv_record_delivery

    # M3: Installation invite checks emailRegistered inside TX under per-email lock shared with createInvitedHuman
    inv_install_fn = slice_between(inv_src, "async inviteInstallation(", "async registerInstallation(")
    inv_tx_body = slice_between(inv_install_fn, "await db.transaction(async (tx) =>", "} catch (error)")
    create_invited_fn = slice_between(acc_src, "async createInvitedHuman(", "async emailRegistered(")
    m3_email_check_in_tx = "await emailRegistered(input.email, tx)" in inv_tx_body
    m3_per_email_lock = (
        "pg_advisory_xact_lock(61683815" in inv_tx_body
        and "pg_advisory_xact_lock(61683815" in create_invited_fn
    )

    install_resend = slice_between(inv_src, "async resendInstallation(", "async revokeInstallation(")
    install_registration = inv_src.split("async registerInstallation(", 1)[1]
    def ordered(source, *markers):
        offset = 0
        for marker in markers:
            offset = source.find(marker, offset)
            if offset < 0:
                return False
            offset += len(marker)
        return True

    m3_resend_serialized = (
        m3_per_email_lock
        and ordered(install_resend, "pg_advisory_xact_lock(61683815", '.for("update")', "await emailRegistered(row.email, tx)", "insert(invitations)")
        and ordered(install_registration, "pg_advisory_xact_lock(61683815", ".update(invitations)", "await createInvitedHuman(")
    )

    # M4: Project updateIssue & updateKnowledge acquire FOR UPDATE before requireIssue / requireKnowledge
    update_issue_fn = slice_between(proj_src, "async updateIssue(", "async listComments(")
    update_knowledge_fn = slice_between(proj_src, "async updateKnowledge(", "  };")
    m4_issue_for_update = bool(
        re.search(r'\.for\("update"\)[\s\S]*await requireIssue\(', update_issue_fn)
    )
    m4_knowledge_for_update = bool(
        re.search(r'\.for\("update"\)[\s\S]*await requireKnowledge\(', update_knowledge_fn)
    )

    # M5: sendTestEmail inserts before sendMail and retires older tokens only after sendMail succeeds
    send_test_fn = slice_between(set_src, "async sendTestEmail(", "async verifyEmail(")
    before_send = slice_between(send_test_fn, "async sendTestEmail(", "await sendMail(")
    after_send = slice_between(send_test_fn, "await sendMail(", "return {")
    m5_no_predelete = ".delete(emailVerificationTokens)" not in before_send
    m5_post_retire_guarded = (
        "stillPresent === undefined" in after_send
        and "ne(emailVerificationTokens.id, tokenId)" in after_send
    )

    # M6: Bootstrap singleton relies on instance_setup primary key inside transaction
    setup_admin_fn = slice_between(acc_src, "async setupAdmin(", "async login(")
    m6_singleton_tx = (
        "await db.transaction(async (tx) =>" in setup_admin_fn
        and "tx.insert(instanceSetup)" in setup_admin_fn
        and '"instance_setup_pkey"' in setup_admin_fn
    )

    # M7: every shared-workspace endpoint must resolve the actor through readMembership
    # with missingKind="workspace_not_found" (or through requireOwner, which does the same)
    # before deciding anything else. A missing target still answers member_not_found, but
    # a missing actor must never distinguish an existing workspace from a missing one.
    read_membership_fn = slice_between(ws_src, "async function readMembership(", "async function requireOwner(")
    require_owner_fn = slice_between(ws_src, "async function requireOwner(", "async function requireProjectManageScope(")
    m7_read_membership_404 = (
        "throw new WorkspacesError(missingKind)" in read_membership_fn
        and '"workspace_not_found" | "member_not_found" | "inviter_not_authorized"' in read_membership_fn
    )
    m7_require_owner_404 = bool(
        re.search(
            r'readMembership\(\s*tx,\s*workspaceId,\s*humanId,\s*"workspace_not_found"\s*,?\s*\)',
            require_owner_fn,
        )
    ) and bool(
        re.search(
            r'if \(!membership\.isOwner\) throw new WorkspacesError\("not_workspace_owner"\)',
            require_owner_fn,
        )
    )

    def actor_lookup_is_not_found(source: str) -> bool:
        return bool(
            re.search(
                r'readMembership\(\s*tx,\s*workspaceId,\s*actor\.humanId,\s*"workspace_not_found"\s*,?\s*\)',
                source,
            )
        )

    members_fn = slice_between(ws_src, "async members(account, workspaceId) {", "async create(account, input) {")
    get_fn = slice_between(ws_src, "async get(account, workspaceId) {", "// The member directory")
    appoint_fn = slice_between(ws_src, "async appointOwner(", "async updateMemberCapability(")
    update_member_fn = slice_between(ws_src, "async updateMemberCapability(", "async removeMember(")
    m7_get_404 = (
        'throw new WorkspacesError("workspace_not_found")' in get_fn
        and "eq(workspaceMemberships.humanId, account.humanId)" in get_fn
    )
    m7_endpoint_reads = {
        "GET /api/workspaces/:id/members": actor_lookup_is_not_found(members_fn),
        "POST /api/workspaces/:id/invitations": actor_lookup_is_not_found(invite_fn),
        "GET /api/workspaces/:id/invitations": actor_lookup_is_not_found(
            slice_between(ws_src, "async invitations(account, workspaceId) {", "async resendInvitation(")
        ),
        "POST /api/workspaces/:id/invitations/:id/resend": actor_lookup_is_not_found(
            slice_between(ws_src, "async resendInvitation(", "async revokeInvitation(")
        ),
        "POST /api/workspaces/:id/invitations/:id/revoke": actor_lookup_is_not_found(
            slice_between(ws_src, "async revokeInvitation(", "async declineInvitation(")
        ),
        "POST /api/workspaces/:id/owners": (
            "await requireOwner(tx, workspaceId, actor.humanId)" in appoint_fn
        ),
        "PATCH /api/workspaces/:id/members/:humanId": actor_lookup_is_not_found(update_member_fn),
        "DELETE /api/workspaces/:id/members/:humanId": actor_lookup_is_not_found(remove_member_fn),
    }
    m7_non_member_404 = (
        m7_read_membership_404
        and m7_require_owner_404
        and m7_get_404
        and all(m7_endpoint_reads.values())
    )

    # M8: Project access grants and creation serialize with workspace membership writes
    create_project_fn = slice_between(proj_src, "async createProject(", "async updateProject(")
    set_access_fn = slice_between(proj_src, "async setProjectAccess(", "async removeProjectAccess(")
    remove_access_fn = slice_between(proj_src, "async removeProjectAccess(", "async revokeMemberProjectAccess(")
    m8_access_serialized = (
        "lockWorkspaceOwnershipWrites(tx)" in create_project_fn
        and "lockWorkspaceOwnershipWrites(tx)" in set_access_fn
        and "lockWorkspaceOwnershipWrites(tx)" in remove_access_fn
        and "revokeMemberProjectAccess(tx" in remove_member_fn
    )

    # M9: These source markers select transitions in a bounded design model. They do
    # not prove transaction wiring or rollback; the real-Postgres tests exercise both.
    preview_fn = slice_between(ws_src, "async previewInvitation(", "async acceptInvitation(")
    accept_fn = slice_between(ws_src, "async acceptInvitation(", "async registerThroughInvitation(")
    register_fn = slice_between(ws_src, "async registerThroughInvitation(", "async appointOwner(")
    resend_fn = slice_between(ws_src, "async resendInvitation(", "async revokeInvitation(")
    apply_grants_fn = slice_between(
        proj_src,
        "async function applyInvitationGrantsInTransaction(",
        "async function lockWorkspaceOwnershipWrites",
    )
    m9_offer_persisted = "insert(workspaceInvitationGrants)" in invite_fn
    m9_existing_applies = (
        "await applyInvitationGrants(" in accept_fn
        and 'WorkspacesError("invitation_scope_invalid")' in accept_fn
    )
    m9_registration_applies = (
        "await applyInvitationGrants(" in register_fn
        and 'WorkspacesError("invitation_scope_invalid")' in register_fn
    )
    m9_grant_writer = "insert(projectAccessGrants)" in apply_grants_fn
    m9_apply_validates = (
        "currentWorkspaceByProject.get(projectId) !== workspaceId" in apply_grants_fn
        and "if (invalid.length > 0) return invalid" in apply_grants_fn
    )
    m9_resend_copies = (
        "workspaceInvitationGrants" in resend_fn
        and "projectId: grant.projectId" in resend_fn
        and "insert(workspaceInvitationGrants)" in resend_fn
    )

    m9_resend_validates = (
        "requireOfferedProjectsInWorkspace(tx, workspaceId, offered)" in resend_fn.split(".update(workspaceInvitations)", 1)[0]
    )
    m9_preview_validates = (
        "loadOfferedProjectGrants(db, row.workspaceId, [row.id])" in preview_fn
        and "grant.projectName === null" in preview_fn
        and 'WorkspacesError("invitation_scope_invalid")' in preview_fn
    )

    # M10: #28 delegation ceilings and the inviter's authority at redemption. Each guard
    # is scoped to the function that owns the decision; a check in another endpoint does
    # not satisfy it.
    revoke_fn = slice_between(ws_src, "async revokeInvitation(", "async declineInvitation(")
    redeem_fn = slice_between(ws_src, "async function redeemWorkspaceInvitation(", "async function requireRecipientNotMember(")
    require_project_manage_fn = slice_between(ws_src, "async function requireProjectManageScope(", "async function requireVerifiedInviter(")
    require_inviter_fn = slice_between(ws_src, "async function requireInviterStillAuthorized(", "// The listing projection")
    m10_owner_only_manager = bool(
        re.search(
            r'if \(requested\.canManageMemberPermissions !== undefined\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_no_owner_modify = bool(
        re.search(
            r'if \(member\.isOwner\) \{\s*if \(!actorMembership\.isOwner\) throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_no_self_modify = bool(
        re.search(
            r'if \(actorMembership\.humanId === humanId\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_capability_ceiling = bool(
        re.search(
            r'if \(requested\[capability\] !== undefined && !actorMembership\[capability\]\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            update_member_fn,
        )
    )
    m10_remove_authority = bool(
        re.search(
            r'if \(!actorMembership\.isOwner && !actorMembership\.canRemoveMembers\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            remove_member_fn,
        )
    )
    m10_remove_protected = bool(
        re.search(
            r'if \(!actorMembership\.isOwner && \(target\.isOwner \|\| target\.canManageMemberPermissions\)\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            remove_member_fn,
        )
    )
    m10_project_manage_guard = (
        "eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage)" in require_project_manage_fn
        and "eq(projects.workspaceId, workspaceId)" in require_project_manage_fn
        and "if (ids.some((id) => !managed.has(id))) throw new WorkspacesError(deniedKind)"
        in require_project_manage_fn
    )

    def scoped_to_inviter(source: str) -> bool:
        return bool(
            re.search(r'await requireProjectManageScope\([\s\S]*?"not_workspace_owner"', source)
        )

    m10_invite_scope = scoped_to_inviter(invite_fn)
    m10_resend_scope = scoped_to_inviter(resend_fn)
    m10_revoke_scope = scoped_to_inviter(revoke_fn)
    m10_redemption_membership = bool(
        re.search(
            r'readMembership\(\s*tx,\s*workspaceId,\s*inviterHumanId,\s*"inviter_not_authorized"\s*,?\s*\)',
            require_inviter_fn,
        )
    )
    m10_redemption_capability = bool(
        re.search(
            r'if \(!inviter\.isOwner && !inviter\.canInviteMembers\) \{\s*throw new WorkspacesError\("inviter_not_authorized"\)',
            require_inviter_fn,
        )
    )
    m10_redemption_verified = (
        'if (inviter.emailVerifiedAt === null) throw new WorkspacesError("inviter_not_authorized")'
        in require_inviter_fn
    )
    m10_redemption_project_scope = bool(
        re.search(
            r'await requireProjectManageScope\(tx, workspaceId, inviter, offered, "inviter_not_authorized"\)',
            require_inviter_fn,
        )
    )
    m10_redeem_checks_inviter = bool(
        re.search(r'await requireInviterStillAuthorized\([\s\S]*?\boffered\b', redeem_fn)
    )
    m10_accept_redeems = "await redeemWorkspaceInvitation(tx, token)" in accept_fn
    m10_register_redeems = "await redeemWorkspaceInvitation(tx, input.token)" in register_fn

    return {
        "m1_serialized": m1_lock_in_service and m1_last_owner_check and m1_db_advisory_lock and m1_db_trigger,
        "m2a_supersedes_failed": m2a_supersedes_failed,
        "m2b_guarded": m2b_ws_guarded and m2b_inv_guarded,
        "m3_serialized": m3_email_check_in_tx and m3_per_email_lock,
        "m3_resend_serialized": m3_resend_serialized,
        "m4_issue_for_update": m4_issue_for_update,
        "m4_knowledge_for_update": m4_knowledge_for_update,
        "m5_safe_rotation": m5_no_predelete and m5_post_retire_guarded,
        "m6_singleton_tx": m6_singleton_tx,
        "m7_non_member_404": m7_non_member_404,
        "m8_access_serialized": m8_access_serialized,
        "m9_offer_persisted": m9_offer_persisted,
        "m9_resend_validates": m9_resend_validates,
        "m9_resend_rejects_member": ordered(resend_fn, "lockWorkspaceForMutation(tx, workspaceId)", "requireRecipientNotMember(tx, workspaceId, row.email)", ".update(workspaceInvitations)", "insert(workspaceInvitations)"),
        "m9_preview_validates": m9_preview_validates,
        "m9_existing_applies": m9_existing_applies,
        "m9_registration_applies": m9_registration_applies,
        "m9_grant_writer": m9_grant_writer,
        "m9_apply_validates": m9_apply_validates,
        "m9_resend_copies": m9_resend_copies,
        "m7_endpoint_reads": m7_endpoint_reads,
        "m7_get_404": m7_get_404,
        "m7_read_membership_404": m7_read_membership_404,
        "m7_require_owner_404": m7_require_owner_404,
        "m10_owner_only_manager": m10_owner_only_manager,
        "m10_no_owner_modify": m10_no_owner_modify,
        "m10_no_self_modify": m10_no_self_modify,
        "m10_capability_ceiling": m10_capability_ceiling,
        "m10_remove_authority": m10_remove_authority,
        "m10_remove_protected": m10_remove_protected,
        "m10_project_manage_guard": m10_project_manage_guard,
        "m10_invite_scope": m10_invite_scope,
        "m10_resend_scope": m10_resend_scope,
        "m10_revoke_scope": m10_revoke_scope,
        "m10_redemption_membership": m10_redemption_membership,
        "m10_redemption_capability": m10_redemption_capability,
        "m10_redemption_verified": m10_redemption_verified,
        "m10_redemption_project_scope": m10_redemption_project_scope,
        "m10_redeem_checks_inviter": m10_redeem_checks_inviter,
        "m10_accept_redeems": m10_accept_redeems,
        "m10_register_redeems": m10_register_redeems,
    }


def bfs_check(
    check_id: str,
    model: str,
    property_name: str,
    kind: str,
    initial_state: Any,
    next_states: Callable[[Any], list[tuple[str, Any]]],
    invariant: Callable[[Any], tuple[bool, str]],
    files: list[str],
    max_states: int = 50000,
) -> CheckResult:
    visited = {initial_state}
    queue = deque([(initial_state, [])])
    transitions = 0

    while queue and len(visited) < max_states:
        state, trace = queue.popleft()
        ok, reason = invariant(state)
        if not ok:
            return CheckResult(
                id=check_id,
                model=model,
                property_name=property_name,
                kind=kind,
                status="violated",
                states_explored=len(visited),
                transitions_explored=transitions,
                summary=reason,
                counterexample=trace,
                files=files,
            )
        for label, nxt in next_states(state):
            transitions += 1
            if nxt not in visited:
                visited.add(nxt)
                queue.append((nxt, trace + [label]))

    return CheckResult(
        id=check_id,
        model=model,
        property_name=property_name,
        kind=kind,
        status="verified",
        states_explored=len(visited),
        transitions_explored=transitions,
        summary=f"Verified across {len(visited)} reachable states ({transitions} transitions).",
        counterexample=[],
        files=files,
    )


def check_m1(facts: dict[str, Any]) -> CheckResult:
    serialized = facts["m1_serialized"]
    init = (frozenset({"u1", "u2"}), frozenset({"u3"}), None, ("idle", None), ("idle", None))

    def step_tx(state, tx_idx):
        owners, members, lock, tx1, tx2 = state
        me = "tx1" if tx_idx == 1 else "tx2"
        pc, target = tx1 if tx_idx == 1 else tx2
        out = []

        def set_tx(no, nm, nl, nt):
            return (no, nm, nl, nt, tx2) if tx_idx == 1 else (no, nm, nl, tx1, nt)

        if pc == "idle":
            for actor in ("u1", "u2", "u3"):
                for tgt in ("u1", "u2", "u3"):
                    out.append((f"{me}: begin removeMember({actor}, {tgt})", set_tx(owners, members, lock, ("want_remove", (actor, tgt)))))
                    out.append((f"{me}: begin appointOwner({actor}, {tgt})", set_tx(owners, members, lock, ("want_appoint", (actor, tgt)))))
        elif pc == "want_remove":
            if serialized:
                if lock is None:
                    out.append((f"{me}: acquire lock_workspace_ownership_writes()", set_tx(owners, members, me, ("locked_remove", target))))
            else:
                # Unserialized snapshot read: both tx1 and tx2 can observe len(owners)==2
                actor, tgt = target
                if actor in owners and (tgt in owners or tgt in members) and (tgt not in owners or len(owners) > 1):
                    out.append((f"{me}: snapshot read sees >1 owners [UNSERIALIZED]", set_tx(owners, members, lock, ("commit_unserialized_remove", tgt))))
                else:
                    out.append((f"{me}: reject remove", set_tx(owners, members, lock, ("idle", None))))
        elif pc == "commit_unserialized_remove":
            out.append((f"{me}: commit DELETE membership({target}) [UNSERIALIZED]", set_tx(owners - {target}, members - {target}, lock, ("idle", None))))
        elif pc == "locked_remove":
            actor, tgt = target
            if actor not in owners or (tgt not in owners and tgt not in members) or (tgt in owners and len(owners) <= 1):
                out.append((f"{me}: rollback remove({tgt})", set_tx(owners, members, None, ("idle", None))))
            else:
                out.append((f"{me}: commit remove({tgt})", set_tx(owners - {tgt}, members - {tgt}, None, ("idle", None))))
        elif pc == "want_appoint":
            if not serialized or lock is None:
                out.append((f"{me}: enter appointOwner", set_tx(owners, members, me if serialized else lock, ("locked_appoint", target))))
        elif pc == "locked_appoint":
            actor, tgt = target
            nl = None if serialized else lock
            if actor in owners and tgt in members:
                out.append((f"{me}: commit appoint({tgt})", set_tx(owners | {tgt}, members - {tgt}, nl, ("idle", None))))
            else:
                out.append((f"{me}: end appoint({tgt})", set_tx(owners, members, nl, ("idle", None))))
        return out

    def inv(state):
        owners, members, _, _, _ = state
        if len(owners) < 1:
            return False, "Shared workspace ended up with 0 owners!"
        if owners & members:
            return False, "Human is simultaneously owner and non-owner!"
        return True, ""

    return bfs_check(
        "M1",
        "Workspace Ownership & Triggers",
        "Shared workspace always retains >= 1 owner under concurrent removals",
        "safety",
        init,
        lambda s: step_tx(s, 1) + step_tx(s, 2),
        inv,
        [
            "apps/server/src/features/workspaces/service.ts",
            "db/migrations/0007_workspace_owner_guards.sql",
            "db/migrations/0008_workspace_ownership_write_order.sql",
        ],
    )


def check_m2a(facts: dict[str, Any]) -> CheckResult:
    supersedes_failed = facts["m2a_supersedes_failed"]
    init = (None, None, False, False)

    def can_reinvite(status, delivery, expired):
        if status is None or status == "expired":
            return True
        if status == "pending" and expired:
            return True
        if status == "pending" and supersedes_failed and delivery == "failed":
            return True
        return False

    def next_states(state):
        status, delivery, expired, in_flight = state
        out = []
        if can_reinvite(status, delivery, expired):
            out.append(("owner: invite() commits pending row (delivery=null, 7d TTL)", ("pending", None, False, True)))
        if in_flight:
            out.append(("smtp: deliver() succeeds -> recordDelivery('sent')", (status, "sent" if status == "pending" else delivery, expired, False)))
            out.append(("smtp: deliver() fails -> recordDelivery('failed')", (status, "failed" if status == "pending" else delivery, expired, False)))
        if status == "pending" and not expired and delivery != "failed":
            out.append(("recipient: redeemWorkspaceInvitation() -> accepted", ("accepted", delivery, expired, in_flight)))
        return out

    def inv(state):
        status, delivery, expired, in_flight = state
        can_redeem = status == "pending" and not expired and delivery != "failed"
        if status == "pending" and not expired and not in_flight and not can_redeem and not can_reinvite(status, delivery, expired):
            return False, "7-day lockout dead state: failed invitation cannot be redeemed and blocks re-invitation."
        return True, ""

    return bfs_check(
        "M2a",
        "Workspace Invitations",
        "No 7-day lockout after failed SMTP delivery",
        "liveness",
        init,
        next_states,
        inv,
        ["apps/server/src/features/workspaces/service.ts"],
    )


def check_m2b(facts: dict[str, Any]) -> CheckResult:
    guarded = facts["m2b_guarded"]
    init = (None, None, False)

    def next_states(state):
        status, delivery, in_flight = state
        out = []
        if status is None:
            out.append(("invite() commits pending row (delivery=null)", ("pending", None, True)))
        if in_flight:
            new_fail = ("failed" if status == "pending" else delivery) if guarded else "failed"
            new_sent = ("sent" if status == "pending" else delivery) if guarded else "sent"
            out.append(("deliver() throws late error -> recordDelivery('failed')", (status, new_fail, False)))
            out.append(("deliver() succeeds -> recordDelivery('sent')", (status, new_sent, False)))
        if status == "pending" and delivery != "failed":
            out.append(("recipient redeems token -> status='accepted'", ("accepted", delivery, in_flight)))
        return out

    def inv(state):
        status, delivery, _ = state
        if status == "accepted" and delivery == "failed":
            return False, "Accepted invitation overwritten with delivery_status='failed'."
        return True, ""

    return bfs_check(
        "M2b",
        "Invitation Delivery Tracking",
        "Accepted invitation never has delivery_status='failed'",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/workspaces/service.ts",
            "apps/server/src/features/invitations/service.ts",
        ],
    )


def check_m3(facts: dict[str, Any]) -> CheckResult:
    init = (False, "pending_stale_null", None, "idle", "idle", None)

    def next_states(state):
        human, inv_s, lock, admin_pc, reg_pc, action = state
        if action is None:
            return [
                ("model: start with an initial installation invite", (*state[:-1], "inviteInstallation")),
                ("model: start with a resend of an expired invitation", (human, "expired", lock, admin_pc, reg_pc, "resendInstallation")),
            ]
        serialized = facts["m3_serialized" if action == "inviteInstallation" else "m3_resend_serialized"]
        out = []
        if serialized:
            if admin_pc == "idle" and lock is None:
                out.append((f"admin: {action}() acquires per-email lock", (human, inv_s, "admin", "locked", reg_pc)))
            elif admin_pc == "locked":
                if human:
                    out.append(("admin: emailRegistered(tx)=true -> rollback account_exists", (human, inv_s, None, "done_rejected", reg_pc)))
                else:
                    out.append(("admin: emailRegistered(tx)=false -> supersede & insert pending", (human, "pending_fresh", None, "done_ok", reg_pc)))
            if reg_pc == "idle" and lock is None and not human:
                out.append(("recipient: createInvitedHuman() acquires per-email lock", (human, inv_s, "reg", admin_pc, "locked")))
            elif reg_pc == "locked":
                out.append(("recipient: createInvitedHuman() commits human", (True, "accepted", None, admin_pc, "done")))
        else:
            if admin_pc == "idle" and (not human or action == "resendInstallation"):
                out.append((f"admin: {action}() starts without a serialized account check", (human, inv_s, lock, "checked", reg_pc)))
            elif admin_pc == "checked":
                tag = "done_after_human" if human else "done_ok"
                out.append((f"admin: {action}() TX commits pending without rechecking humans", (human, "pending_fresh", lock, tag, reg_pc)))
            if reg_pc == "idle" and not human:
                out.append(("recipient: registers account & commits human", (True, "accepted", lock, admin_pc, "done")))
        return [(label, (*next_state, action)) for label, next_state in out]

    def inv(state):
        _, _, _, admin_pc, _, _ = state
        if admin_pc == "done_after_human":
            return False, "TOCTOU: fresh pending installation invitation committed after account already existed."
        return True, ""

    return bfs_check(
        "M3",
        "Installation Invitations",
        "No fresh pending installation invitation committed after email is registered",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/invitations/service.ts",
            "apps/server/src/features/accounts/service.ts",
        ],
    )


def check_m4(facts: dict[str, Any]) -> CheckResult:
    locked = facts["m4_issue_for_update"] and facts["m4_knowledge_for_update"]
    init = (("T1", "open"), (), None, ("idle",), ("idle",), ("idle",))

    def next_states(state):
        (title, status), activity, lock, tx1, tx2, tx3 = state
        out = []

        if locked:
            if tx1[0] == "idle" and lock is None:
                out.append(("tx1(close): SELECT ... FOR UPDATE", ((title, status), activity, "tx1", ("locked",), tx2, tx3)))
            elif tx1[0] == "locked":
                if status == "closed":
                    out.append(("tx1(close): no-op", ((title, status), activity, None, ("done",), tx2, tx3)))
                else:
                    out.append(("tx1(close): commit closed + issue_closed", ((title, "closed"), activity + ("issue_closed",), None, ("done",), tx2, tx3)))

            if tx2[0] == "idle" and lock is None:
                out.append(("tx2(edit): SELECT ... FOR UPDATE", ((title, status), activity, "tx2", tx1, ("locked",), tx3)))
            elif tx2[0] == "locked":
                out.append(("tx2(edit): commit title=T2 + issue_edited", (("T2", status), activity + ("issue_edited",), None, tx1, ("done",), tx3)))

            if tx3[0] == "idle" and lock is None:
                out.append(("tx3(close2): SELECT ... FOR UPDATE", ((title, status), activity, "tx3", tx1, tx2, ("locked",))))
            elif tx3[0] == "locked":
                if status == "closed":
                    out.append(("tx3(close2): no-op", ((title, status), activity, None, tx1, tx2, ("done",))))
                else:
                    out.append(("tx3(close2): commit closed + issue_closed", ((title, "closed"), activity + ("issue_closed",), None, tx1, tx2, ("done",))))
        else:
            if tx1[0] == "idle":
                out.append((f"tx1(close): requireIssue() reads ({title}, {status}) [NO FOR UPDATE]", ((title, status), activity, lock, ("read", title, status), tx2, tx3)))
            elif tx1[0] == "read":
                _, st, ss = tx1
                if ss == "closed":
                    out.append(("tx1(close): no-op", ((title, status), activity, lock, ("done",), tx2, tx3)))
                else:
                    out.append((f"tx1(close): UPDATE ({st}, closed) + issue_closed", ((st, "closed"), activity + ("issue_closed",), lock, ("done",), tx2, tx3)))

            if tx2[0] == "idle":
                out.append((f"tx2(edit): requireIssue() reads ({title}, {status}) [NO FOR UPDATE]", ((title, status), activity, lock, tx1, ("read", title, status), tx3)))
            elif tx2[0] == "read":
                _, _, ss = tx2
                out.append((f"tx2(edit): UPDATE (T2, {ss}) + issue_edited", (("T2", ss), activity + ("issue_edited",), lock, tx1, ("done",), tx3)))

            if tx3[0] == "idle":
                out.append((f"tx3(close2): requireIssue() reads ({title}, {status}) [NO FOR UPDATE]", ((title, status), activity, lock, tx1, tx2, ("read", title, status))))
            elif tx3[0] == "read":
                _, st, ss = tx3
                if ss == "closed":
                    out.append(("tx3(close2): no-op", ((title, status), activity, lock, tx1, tx2, ("done",))))
                else:
                    out.append((f"tx3(close2): UPDATE ({st}, closed) + issue_closed", ((st, "closed"), activity + ("issue_closed",), lock, tx1, tx2, ("done",))))
        return out

    def inv(state):
        (title, status), activity, _, tx1, tx2, tx3 = state
        if activity.count("issue_closed") > 1:
            return False, f"Duplicate issue_closed events under concurrency: {list(activity)}"
        if tx1[0] == "done" and tx2[0] == "done" and tx3[0] == "done":
            if title != "T2" or status != "closed":
                return False, f"Lost update: DB has (title={title}, status={status}), activity={list(activity)}"
        return True, ""

    return bfs_check(
        "M4",
        "Project Issues & Knowledge",
        "Concurrent PATCHes preserve edits, match activity log, and emit <= 1 issue_closed",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/projects/service.ts"],
    )


def check_m5(facts: dict[str, Any]) -> CheckResult:
    safe = facts["m5_safe_rotation"]
    init = (frozenset(), "idle", "idle", frozenset())

    def next_states(state):
        live, c1, c2, ok = state
        out = []
        if safe:
            if c1 == "idle":
                out.append(("call1: insert tok1", (live | {"tok1"}, "sending", c2, ok)))
            elif c1 == "sending":
                nl = frozenset({"tok1"}) if "tok1" in live else live
                out.append(("call1: sendMail ok -> retire older if tok1 present -> 200", (nl, "done", c2, ok | {"tok1"})))
                out.append(("call1: sendMail fails -> delete tok1 only", (live - {"tok1"}, "done", c2, ok)))
            if c2 == "idle":
                out.append(("call2: insert tok2", (live | {"tok2"}, c1, "sending", ok)))
            elif c2 == "sending":
                nl = frozenset({"tok2"}) if "tok2" in live else live
                out.append(("call2: sendMail ok -> retire older if tok2 present -> 200", (nl, c1, "done", ok | {"tok2"})))
                out.append(("call2: sendMail fails -> delete tok2 only", (live - {"tok2"}, c1, "done", ok)))
        else:
            if c1 == "idle":
                out.append(("call1: delete all unused & insert tok1", (frozenset({"tok1"}), "sending", c2, ok)))
            elif c1 == "sending":
                out.append(("call1: sendMail ok -> 200", (live, "done", c2, ok | {"tok1"})))
                out.append(("call1: sendMail fails -> delete tok1", (live - {"tok1"}, "done", c2, ok)))
            if c2 == "idle":
                out.append(("call2: delete all unused & insert tok2", (frozenset({"tok2"}), c1, "sending", ok)))
            elif c2 == "sending":
                out.append(("call2: sendMail ok -> 200", (live, c1, "done", ok | {"tok2"})))
                out.append(("call2: sendMail fails -> delete tok2", (live - {"tok2"}, c1, "done", ok)))
        return out

    def inv(state):
        live, c1, c2, ok = state
        if c1 == "done" and c2 == "done" and ok:
            if not (live & ok):
                return False, f"All 200-OK verification tokens dead: live={sorted(live)}, ok={sorted(ok)}"
        return True, ""

    return bfs_check(
        "M5",
        "Email Verification Tokens",
        "Settled 200-OK sendTestEmail leaves a live redeemable verification token",
        "liveness",
        init,
        next_states,
        inv,
        ["apps/server/src/features/settings/service.ts"],
    )


def check_m6(facts: dict[str, Any]) -> CheckResult:
    singleton = facts["m6_singleton_tx"]
    init = (False, 0, 0, "idle", "idle")

    def next_states(state):
        done, admins, pws, t1, t2 = state
        out = []
        for idx, t in ((1, t1), (2, t2)):
            if t == "idle":
                if not done or not singleton:
                    out.append((
                        f"setup{idx}: commit admin + personal workspace + instance_setup",
                        (True, admins + 1, pws + 1, "ok" if idx == 1 else t1, "ok" if idx == 2 else t2),
                    ))
                else:
                    out.append((
                        f"setup{idx}: rollback setup_complete (409)",
                        (done, admins, pws, "409" if idx == 1 else t1, "409" if idx == 2 else t2),
                    ))
        return out

    def inv(state):
        done, admins, pws, _, _ = state
        if admins > 1 or (done and (admins != 1 or pws != 1)):
            return False, f"Bootstrap singleton violated: admins={admins}, personal_ws={pws}"
        return True, ""

    return bfs_check(
        "M6",
        "Bootstrap Singleton",
        "Exactly one administrator and personal workspace created across concurrent setups",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/accounts/service.ts"],
    )


def check_m7(facts: dict[str, Any]) -> CheckResult:
    # A non-member probes every endpoint that decides anything in a shared workspace,
    # once against an existing id and once against a missing id. The shared helper and
    # requireOwner apply to all of them, but each endpoint's own actor lookup is checked
    # separately so a correct guard in a neighbouring path cannot hide a leak here.
    endpoints: list[tuple[str, bool]] = [
        ("GET /api/workspaces/:id", facts["m7_get_404"]),
        *[(path, facts["m7_endpoint_reads"][path]) for path in sorted(facts["m7_endpoint_reads"])],
    ]
    helper_ok = facts["m7_read_membership_404"] and facts["m7_require_owner_404"]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        out = []
        for path, lookup_ok in endpoints:
            existing = 404 if helper_ok and lookup_ok else 403
            out.append((f"non-member {path}", ("probed", path, existing, 404)))
        return out

    def inv(state):
        if state[0] == "probed" and state[2] != state[3]:
            return False, f"Enumeration oracle on {state[1]}: existing={state[2]} vs missing={state[3]}"
        return True, ""

    return bfs_check(
        "M7",
        "Workspace Access Boundary",
        "Non-members receive 404 workspace_not_found on every shared-workspace endpoint (never 403)",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/workspaces/service.ts"],
    )


def check_m8(facts: dict[str, Any]) -> CheckResult:
    # Models setProjectAccess() racing with removeMember() on a shared workspace member.
    serialized = facts["m8_access_serialized"]
    # State: (is_member, has_grant, lock, grant_pc, remove_pc)
    init = (True, False, None, "idle", "idle")

    def next_states(state):
        is_member, has_grant, lock, g_pc, r_pc = state
        out = []
        if serialized:
            if g_pc == "idle" and lock is None:
                out.append(("setProjectAccess: acquire lock_workspace_ownership_writes()", (is_member, has_grant, "grant", "locked", r_pc)))
            elif g_pc == "locked":
                if is_member:
                    out.append(("setProjectAccess: commit grant", (is_member, True, None, "done", r_pc)))
                else:
                    out.append(("setProjectAccess: reject member_not_found", (is_member, has_grant, None, "done", r_pc)))
            if r_pc == "idle" and lock is None:
                out.append(("removeMember: acquire lock_workspace_ownership_writes()", (is_member, has_grant, "remove", g_pc, "locked")))
            elif r_pc == "locked":
                out.append(("removeMember: delete membership + revoke grants + commit", (False, False, None, g_pc, "done")))
        else:
            if g_pc == "idle" and is_member:
                out.append(("setProjectAccess: trigger sees member & inserts grant (uncommitted)", (is_member, has_grant, lock, "inserted", r_pc)))
            elif g_pc == "inserted":
                out.append(("setProjectAccess: commits grant", (is_member, True, lock, "done", r_pc)))
            if r_pc == "idle" and is_member:
                out.append(("removeMember: deletes membership & sees 0 committed grants", (False, False, lock, g_pc, "done")))
        return out

    def inv(state):
        is_member, has_grant, _, g_pc, r_pc = state
        if g_pc == "done" and r_pc == "done" and not is_member and has_grant:
            return False, "Orphaned project_access_grants row survived removeMember() and will revive on rejoin!"
        return True, ""

    return bfs_check(
        "M8",
        "Project Access Grants (#27)",
        "No orphaned project_access_grants row survives concurrent removeMember()",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/workspaces/service.ts",
            "db/migrations/0012_project_access_scope.sql",
        ],
    )


def check_m9(facts: dict[str, Any]) -> CheckResult:
    # The offer is a project in the invited workspace. It can be moved to another
    # workspace after the invitation is created, and it can be resent before acceptance.
    # The model assumes atomic commits and rollback. It checks scope and preservation
    # under that assumption, not whether the database actually rolls back every write.
    offer_persisted = facts["m9_offer_persisted"]
    existing_checked = facts["m9_existing_applies"] and facts["m9_apply_validates"]
    registration_checked = facts["m9_registration_applies"] and facts["m9_apply_validates"]
    resend_validates = facts["m9_resend_validates"]
    preview_validates = facts["m9_preview_validates"]
    resend_copies = facts["m9_resend_copies"]
    initial = ("invited", offer_persisted, "pending", False, False, False)

    def next_states(state):
        project_workspace, offer_present, token, membership, grant, resent = state
        out = []
        if project_workspace == "invited" and token == "pending":
            out.append(
                (
                    "project transfer: project.workspace_id changes after the offer",
                    ("other", offer_present, token, membership, grant, resent),
                )
            )
        scope_valid = not offer_present or project_workspace == "invited"
        if token == "pending" and not membership:
            out.append(("recipient: joins via a newer offer after the original expires", (project_workspace, offer_present, "expired", True, grant, resent)))
        if token in ("pending", "expired") and not resent:
            if membership:
                if not facts["m9_resend_rejects_member"]:
                    out.append(("resendInvitation: mails an existing member", (project_workspace, offer_present, "member_resend", membership, grant, True)))
            elif not scope_valid and not resend_validates:
                out.append(("resendInvitation: rotates a stale offer", (project_workspace, offer_present, "stale_resend", membership, grant, True)))
            elif scope_valid and offer_present and not resend_copies:
                out.append(
                    (
                        "resendInvitation: replacement loses the offered project",
                        (project_workspace, False, token, membership, grant, True),
                    )
                )
            elif scope_valid:
                out.append(
                    (
                        "resendInvitation: replacement copies the offered project",
                        (project_workspace, offer_present, token, membership, grant, True),
                    )
                )
        if token == "pending":
            if not scope_valid and not preview_validates:
                out.append(("previewInvitation: exposes a stale offer", (project_workspace, offer_present, "stale_preview", membership, grant, resent)))
            for path, checked, applies in (
                ("acceptInvitation", existing_checked, facts["m9_existing_applies"]),
                ("registerThroughInvitation", registration_checked, facts["m9_registration_applies"]),
            ):
                if offer_present and project_workspace != "invited" and checked:
                    # The common redemption path rejects before committing, so the
                    # token and every row stay as they were.
                    continue
                grant_written = offer_present and applies and facts["m9_grant_writer"]
                out.append(
                    (
                        f"{path}: commit acceptance",
                        (project_workspace, offer_present, "accepted", True, grant_written, resent),
                    )
                )
        return out

    def inv(state):
        project_workspace, offer_present, token, membership, grant, resent = state
        if not offer_persisted:
            return False, "Invitation creation does not persist any offered project grant!"
        if token == "member_resend":
            return False, "An existing workspace member was sent a replacement invitation!"
        if token in ("stale_resend", "stale_preview"):
            return False, "An invitation with stale project scope was exposed or rotated!"
        if grant and project_workspace != "invited":
            return False, "A project grant was applied after its project left the invited workspace!"
        if token == "accepted" and offer_present and not grant:
            return False, "Acceptance omitted an offered project grant!"
        if resent and not offer_present:
            return False, "Resend lost the offered project grant!"
        return True, ""

    return bfs_check(
        "M9",
        "Workspace Invitation Project Grants (#25)",
        "Valid project scope survives resend; stale scope and existing members cannot receive replacements",
        "safety",
        initial,
        next_states,
        inv,
        [
            "apps/server/src/features/workspaces/service.ts",
            "apps/server/src/features/projects/service.ts",
        ],
    )


def check_m10(facts: dict[str, Any]) -> CheckResult:
    # #28 delegation ceilings and inviter authority. Every scenario is a direct attempt
    # against the service's decision points; the BFS depth is one transition because the
    # decisions are independent and each has a single commit/reject outcome. The guard
    # for each attempt is extracted from its own function, so deleting one guard produces
    # a short counterexample naming the exact API path and TS function.
    cap_ceiling = facts["m10_capability_ceiling"]
    project_guard = facts["m10_project_manage_guard"]
    redeems = facts["m10_redeem_checks_inviter"]
    accept_check = redeems and facts["m10_accept_redeems"]
    register_check = redeems and facts["m10_register_redeems"]

    # (API call in the code's own words, forbidden?, guard that prevents the commit)
    attempts: list[tuple[str, bool, bool]] = [
        ("updateMemberCapability(permission manager, other member, {canManageMemberPermissions:true})", True, facts["m10_owner_only_manager"]),
        ("updateMemberCapability(permission manager, other member, {canManageMemberPermissions:false})", True, facts["m10_owner_only_manager"]),
        ("updateMemberCapability(permission manager, owner, {canCreateProjects:true})", True, facts["m10_no_owner_modify"]),
        ("updateMemberCapability(permission manager, themselves, {canCreateProjects:true})", True, facts["m10_no_self_modify"]),
        ("updateMemberCapability(permission manager without Invite members, other member, {canInviteMembers:true})", True, cap_ceiling),
        ("updateMemberCapability(permission manager without Remove members, other member, {canRemoveMembers:false})", True, cap_ceiling),
        ("removeMember(member with Remove members, owner)", True, facts["m10_remove_protected"]),
        ("removeMember(member with Remove members, permission manager)", True, facts["m10_remove_protected"]),
        ("removeMember(ordinary member without Remove members, other member)", True, facts["m10_remove_authority"]),
        ("invite(delegated inviter without Manage, projectGrants:[unmanaged project])", True, facts["m10_invite_scope"] and project_guard),
        ("resendInvitation(delegated inviter, offer with an unmanaged project)", True, facts["m10_resend_scope"] and project_guard),
        ("revokeInvitation(delegated inviter, offer with an unmanaged project)", True, facts["m10_revoke_scope"] and project_guard),
        ("acceptInvitation(inviter lost canInviteMembers)", True, accept_check and facts["m10_redemption_capability"]),
        ("registerThroughInvitation(inviter lost canInviteMembers)", True, register_check and facts["m10_redemption_capability"]),
        ("acceptInvitation(inviter lost Manage on the offered project)", True, accept_check and facts["m10_redemption_project_scope"] and project_guard),
        ("registerThroughInvitation(inviter lost Manage on the offered project)", True, register_check and facts["m10_redemption_project_scope"] and project_guard),
        ("acceptInvitation(inviter left the workspace)", True, accept_check and facts["m10_redemption_membership"]),
        ("registerThroughInvitation(inviter left the workspace)", True, register_check and facts["m10_redemption_membership"]),
        ("acceptInvitation(inviter's email is no longer verified)", True, accept_check and facts["m10_redemption_verified"]),
        ("registerThroughInvitation(inviter's email is no longer verified)", True, register_check and facts["m10_redemption_verified"]),
        # Positive controls: the ceilings must not turn legitimate delegation into a no-op.
        ("updateMemberCapability(owner, non-owner, all four capabilities)", False, True),
        ("updateMemberCapability(permission manager holding Create projects, other member, {canCreateProjects:true})", False, True),
        ("removeMember(member with Remove members, ordinary member)", False, True),
        ("invite(delegated inviter with Manage, projectGrants:[managed project])", False, True),
        ("invite(delegated inviter, projectGrants:[])", False, True),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        out = []
        for idx, (label, forbidden, guard) in enumerate(attempts):
            result = "rejected" if forbidden and guard else "committed"
            out.append((f"{label} -> {result}", ("probed", idx, result)))
        return out

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, forbidden, _ = attempts[state[1]]
        expected = "rejected" if forbidden else "committed"
        if state[2] != expected:
            return False, f"{label} {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M10",
        "Workspace Permission Delegation & Inviter Authority (#28)",
        "Only owners appoint permission managers, delegates stay within their own authority, and withdrawn inviter authority cannot be redeemed",
        "safety",
        init,
        next_states,
        inv,
        ["apps/server/src/features/workspaces/service.ts"],
    )


def main() -> None:
    facts = extract_code_facts()
    results = [
        check_m1(facts),
        check_m2a(facts),
        check_m2b(facts),
        check_m3(facts),
        check_m4(facts),
        check_m5(facts),
        check_m6(facts),
        check_m7(facts),
        check_m8(facts),
        check_m9(facts),
        check_m10(facts),
    ]

    if "--json" in sys.argv:
        print(
            json.dumps(
                {
                    "facts": facts,
                    "results": [r.__dict__ for r in results],
                },
                indent=2,
            )
        )
    else:
        for r in results:
            tag = "PASS" if r.status == "verified" else "FAIL"
            print(f"[{tag}] {r.id} ({r.model}): {r.property_name}")
            print(f"       {r.summary}")
            if r.counterexample:
                print("       Counterexample:")
                for i, step in enumerate(r.counterexample, 1):
                    print(f"         {i}. {step}")

    failed = [r for r in results if r.status != "verified"]
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
