#!/usr/bin/env python3
"""
Orrery Formal Verification Model Checker (M1-M18).

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
    # #32 history views: the scope decisions live in one service, the transport is thin,
    # and the response shape is the shared contract. All three are read so deleting a
    # guard flips the M13 attempts below to their wrong outcomes.
    hist_src = read_text("apps/server/src/features/history/service.ts")
    hist_rest = read_text("apps/server/src/features/history/rest.ts")
    hist_contract = read_text("packages/contract/src/history.ts")
    mig_0007 = read_text("db/migrations/0007_workspace_owner_guards.sql")
    mig_0008 = read_text("db/migrations/0008_workspace_ownership_write_order.sql")

    # #37: removal and voluntary leave share one private cleanup tail. M1, M8, M11 and M18
    # all inspect it, so define it once here rather than repeating the slice below.
    end_membership_fn = slice_between(ws_src, "async function endMembership(", "\n  }\n\n  return {")

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

    # #33 (agent project work through MCP) reads its own transport, contract, and schema
    # sources so removing a guard or registering an admin tool flips the model below.
    mcp_src = read_text("apps/server/src/features/projects/mcp.ts")
    tools_src = read_text("packages/contract/src/mcp-tools.ts")
    proj_rest_src = read_text("apps/server/src/features/projects/rest.ts")
    mig_0017 = read_text("db/migrations/0017_rapid_talon.sql")

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

    # The invitation-management endpoints share requireInviter(), which performs the same
    # non-enumerating actor lookup. Check both the helper and that each endpoint calls it.
    require_inviter_fn = slice_between(ws_src, "async function requireInviter(", "async function requireProjectManageScope(")
    m7_require_inviter_404 = bool(
        re.search(
            r'readMembership\(\s*tx,\s*workspaceId,\s*humanId,\s*"workspace_not_found"\s*,?\s*\)',
            require_inviter_fn,
        )
    ) and bool(
        re.search(
            r'if \(!inviter\.isOwner && !inviter\.canInviteMembers\) \{\s*throw new WorkspacesError\("not_workspace_owner"\)',
            require_inviter_fn,
        )
    )

    def inviter_lookup_is_not_found(source: str) -> bool:
        return (
            "await requireInviter(tx, workspaceId, actor.humanId)" in source
            or actor_lookup_is_not_found(source)
        )

    members_fn = slice_between(ws_src, "async members(account, workspaceId) {", "async create(account, input) {")
    get_fn = slice_between(ws_src, "async get(account, workspaceId) {", "// The member directory")
    invitations_fn = slice_between(ws_src, "async invitations(account, workspaceId) {", "async resendInvitation(")
    resend_fn = slice_between(ws_src, "async resendInvitation(", "async revokeInvitation(")
    revoke_fn = slice_between(ws_src, "async revokeInvitation(", "async declineInvitation(")
    appoint_fn = slice_between(ws_src, "async appointOwner(", "async updateMemberCapability(")
    update_member_fn = slice_between(ws_src, "async updateMemberCapability(", "async removeMember(")
    m7_get_404 = (
        'throw new WorkspacesError("workspace_not_found")' in get_fn
        and "eq(workspaceMemberships.humanId, account.humanId)" in get_fn
    )
    m7_endpoint_reads = {
        "GET /api/workspaces/:id/members": actor_lookup_is_not_found(members_fn),
        "POST /api/workspaces/:id/invitations": inviter_lookup_is_not_found(invite_fn),
        "GET /api/workspaces/:id/invitations": inviter_lookup_is_not_found(invitations_fn),
        "POST /api/workspaces/:id/invitations/:id/resend": inviter_lookup_is_not_found(resend_fn),
        "POST /api/workspaces/:id/invitations/:id/revoke": inviter_lookup_is_not_found(revoke_fn),
        "POST /api/workspaces/:id/owners": (
            "await requireOwner(tx, workspaceId, actor.humanId)" in appoint_fn
        ),
        "PATCH /api/workspaces/:id/members/:humanId": actor_lookup_is_not_found(update_member_fn),
        "DELETE /api/workspaces/:id/members/:humanId": actor_lookup_is_not_found(remove_member_fn),
    }
    m7_non_member_404 = (
        m7_read_membership_404
        and m7_require_owner_404
        and m7_require_inviter_404
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
        # #37 moved the grant revocation into the shared cleanup tail: the removal must
        # call that tail, and the tail must still revoke the departing member's grants.
        and "endMembership(" in remove_member_fn
        and "revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
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

    # An owner whose offered project moved out of the workspace must no longer make the
    # address look live: inviterStillAuthorized checks the offered scope before its owner
    # early-return, so a fresh invite supersedes the dead offer instead of 409-ing.
    still_live_fn = slice_between(
        ws_src, "async function inviterStillAuthorized(", "// The listing projection"
    )
    scope_check = still_live_fn.find("await offeredProjectsInWorkspace(tx, workspaceId, offered)")
    owner_return = still_live_fn.find("if (inviter.isOwner) return true")
    m9_owner_stale_supersedes = (
        scope_check >= 0
        and owner_return >= 0
        and scope_check < owner_return
        and "eq(projects.workspaceId, workspaceId)" in slice_between(
            ws_src, "async function offeredProjectsInWorkspace(", "async function requireOfferedProjectsInWorkspace("
        )
    )

    # M10: #28 delegation ceilings and the inviter's authority at redemption. Each guard
    # is scoped to the function that owns the decision; a check in another endpoint does
    # not satisfy it.
    revoke_fn = slice_between(ws_src, "async revokeInvitation(", "async declineInvitation(")
    redeem_fn = slice_between(ws_src, "async function redeemWorkspaceInvitation(", "async function requireRecipientNotMember(")
    require_project_manage_fn = slice_between(ws_src, "async function requireProjectManageScope(", "async function requireVerifiedInviter(")
    still_authorized_fn = slice_between(ws_src, "async function requireInviterStillAuthorized(", "// The listing projection")
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
            still_authorized_fn,
        )
    )
    m10_redemption_capability = bool(
        re.search(
            r'if \(!inviter\.isOwner && !inviter\.canInviteMembers\) \{\s*throw new WorkspacesError\("inviter_not_authorized"\)',
            still_authorized_fn,
        )
    )
    m10_redemption_verified = (
        'if (inviter.emailVerifiedAt === null) throw new WorkspacesError("inviter_not_authorized")'
        in still_authorized_fn
    )
    m10_redemption_project_scope = bool(
        re.search(
            r'await requireProjectManageScope\(tx, workspaceId, inviter, offered, "inviter_not_authorized"\)',
            still_authorized_fn,
        )
    )
    m10_redeem_checks_inviter = bool(
        re.search(r'await requireInviterStillAuthorized\([\s\S]*?\boffered\b', redeem_fn)
    )
    m10_accept_redeems = "await redeemWorkspaceInvitation(tx, token)" in accept_fn
    m10_register_redeems = "await redeemWorkspaceInvitation(tx, input.token)" in register_fn
    # #28 review fixes: a delegate's history is scoped to projects they Manage, a dead
    # pending offer cannot block an address, and an inviter may always revoke their own.
    m10_list_scoping = (
        "await loadManagedProjectIds(tx, workspaceId, actor.humanId)" in invitations_fn
        and "offered.every((grant) => managed.has(grant.projectId))" in invitations_fn
    )
    m10_dead_offer_supersedes = (
        "await inviterStillAuthorized(" in invite_fn
        and "eq(workspaceInvitations.id, blocking.id)" in invite_fn
    )
    m10_self_revoke = "if (row.invitedByHumanId !== actor.humanId)" in revoke_fn

    # M11 (#30): workspace-scoped agent API keys. Each guard is extracted from the
    # function that owns the decision, so removing one produces a short counterexample
    # naming the exact API path and TS function instead of a generic model failure.
    ag_src = read_text("apps/server/src/features/agents/service.ts")
    ag_schema = read_text("apps/server/src/db/schema.ts")
    resolve_fn = slice_between(
        ag_src, "async function resolveKeyInTransaction(", "export function createAgentsService"
    )
    issue_fn = slice_between(ag_src, "async issueKey(", "async listKeys(")
    revoke_own_fn = slice_between(ag_src, "async function revokeInTransaction(", "export async function revokeMemberWorkspaceKeys(")
    revoke_member_fn = slice_between(
        ag_src, "export async function revokeMemberWorkspaceKeys(", "// Bearer resolution inside one transaction"
    )
    authenticate_fn = slice_between(ag_src, "async authenticate(", "  };")
    record_fn = slice_between(ag_src, "async function recordEvent(", "type KeyRow")
    owner_fn = slice_between(ag_src, "async ownerRevokeKey(", "async authenticate(")
    events_table = slice_between(ag_schema, "export const agentKeyEvents = pgTable(", "// An issue in a project.")
    mig_0018 = read_text("db/migrations/0018_agent_key_project_scope.sql")

    # Removal revokes the member's workspace keys in the removal's own transaction, with
    # one secret-free event per newly revoked key; issuance takes the ownership lock so
    # no INSERT can land after that revocation. Authentication reads one REPEATABLE READ
    # snapshot, and the database rejects a key grant outside the key's workspace.
    m11_member_removal_revokes_keys = (
        # #37: removeMember delegates the cleanup to endMembership; both the call and the
        # key revocation inside the tail must be present for a rejoin to stay revoked.
        "endMembership(" in remove_member_fn
        and "revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
        and "revokedAt: sql`now()`" in revoke_member_fn
        and "isNull(agentApiKeys.revokedAt)" in revoke_member_fn
        and "AgentKeyEventType.enum.agent_key_revoked" in revoke_member_fn
    )
    m11_issue_serialized = "await lockWorkspaceOwnershipWrites(tx)" in issue_fn.split(
        "const [agent]", 1
    )[0]
    m11_repeatable_read_auth = (
        'isolationLevel: "repeatable read"' in authenticate_fn
        and 'accessMode: "read only"' in authenticate_fn
    )
    m11_key_project_scope_db = (
        "CREATE TRIGGER agent_key_project_scope\n" in mig_0018
        and "BEFORE INSERT OR UPDATE ON agent_api_key_projects" in mig_0018
        and "key_workspace <> project_workspace" in mig_0018
        and "RAISE EXCEPTION" in mig_0018
    )

    m11_revocation = (
        "row.key.revokedAt !== null" in resolve_fn
        and 'throw new AgentsError("key_revoked")' in resolve_fn
        and "revokedAt: sql`now()`" in revoke_own_fn
    )
    m11_membership = (
        "humanCanUseWorkspace(tx, row.key.workspaceId, row.humanId)" in resolve_fn
        and 'throw new AgentsError("key_workspace_inaccessible")' in resolve_fn
    )
    m11_expiry = (
        "gt(agentApiKeys.expiresAt, sql`now()`)" in resolve_fn
        and 'throw new AgentsError("key_expired")' in resolve_fn
    )
    expiry_block = slice_between(
        resolve_fn,
        "if (AgentKeyValidity.parse(row.key.validity) !== AgentKeyValidity.enum.never)",
        "// A key is scoped",
    )
    m11_never_skips_expiry_only = (
        "gt(agentApiKeys.expiresAt" in expiry_block
        and "row.key.revokedAt" not in expiry_block
        and "humanCanUseWorkspace" not in expiry_block
        and "projectAccessCeiling(" not in expiry_block
    )
    m11_scope = (
        "target.workspaceId !== row.key.workspaceId" in resolve_fn
        and 'throw new AgentsError("key_out_of_scope")' in resolve_fn
    )
    m11_project_scope = (
        "effective.some((grant) => grant.projectId === target.projectId)" in resolve_fn
        and 'throw new AgentsError("insufficient_agent_access")' in resolve_fn
    )
    m11_ceiling = bool(
        re.search(r"projectAccessCeiling\(", resolve_fn)
        and re.search(
            r"projectAccessAtLeast\(humanLevel,\s*grant\.level\)\s*\?\s*grant\.level\s*:\s*humanLevel",
            resolve_fn,
        )
    )
    m11_issue_ceiling = bool(
        re.search(r"!projectAccessAtLeast\(humanLevel,\s*grant\.level\)", issue_fn)
        and 'throw new AgentsError("invalid_key_grant")' in issue_fn
    )
    m11_single_event = (
        ".returning({ id: agentApiKeys.id })" in revoke_own_fn
        and "if (updated.length > 0)" in revoke_own_fn
        and "recordEvent(" in revoke_own_fn
    )
    m11_owner_isolation = (
        "requireWorkspaceOwner(tx, workspaceId, actor.humanId)" in owner_fn
        and "eq(agentApiKeys.workspaceId, workspaceId)" in owner_fn
    )
    m11_key_hash_only = (
        "tokenHash: tokenHash(secret)" in issue_fn
        and "secret:" not in slice_between(issue_fn, ".insert(agentApiKeys)", ".returning(")
    )
    m11_events = (
        "insert(agentKeyEvents)" in record_fn
        and "AgentKeyEventType.enum.agent_key_created" in issue_fn
        and "AgentKeyEventType.enum.agent_key_revoked" in revoke_own_fn
        and "recordEvent(" in revoke_own_fn
    )
    m11_events_without_secret = (
        "token_hash" not in events_table
        and "tokenHash:" not in events_table
        and "secret:" not in events_table
    )

    # M12 (#33): one policy path for REST and MCP, agent-attributed writes, and no
    # membership or installation administration reachable by an agent key.
    actor_level_fn = slice_between(proj_src, "function actorAccessLevel(", "function requireLevel(")
    m12_agent_scope = (
        "actor.identity.workspaceId" in actor_level_fn
        and "facts.workspaceId !== actor.identity.workspaceId" in actor_level_fn
        and "actor.identity.projects.find((grant) => grant.projectId === facts.projectId)" in actor_level_fn
    )
    m12_shared_gate = (
        "function requireLevel(" in proj_src
        and "actorAccessLevel(facts, actor)" in proj_src
        and all(
            f'requireLevel({arg}, actor, required, "{kind}")' in proj_src
            for arg, kind in [
                ("facts", "project_not_found"),
                ("row", "issue_not_found"),
                ("row", "knowledge_entry_not_found"),
            ]
        )
    )
    record_activity_fn = slice_between(proj_src, "async function recordActivity(", "// One project access-change event")
    m12_agent_actor = (
        "actorHumanId: humanIdOf(input.actor)" in record_activity_fn
        and "actorAgentId: agentIdOf(input.actor)" in record_activity_fn
        and "humanIdOf(actor)" in proj_src
        and "agentIdOf(actor)" in proj_src
    )
    m12_actor_constraint = (
        "issues_created_by_actor" in mig_0017
        and "project_activity_actor" in mig_0017
        and "created_by_agent_id" in mig_0017
        and "actor_agent_id" in mig_0017
        and "actorHumanId: text(\"actor_human_id\").references(() => humans.id)" in ag_schema
        and "actorAgentId: text(\"actor_agent_id\").references(() => agents.id)" in ag_schema
    )
    list_projects_service = slice_between(proj_src, "async listProjects(", "async getProject(")
    m12_list_scope = (
        "actor.kind === \"agent\" && workspaceId !== actor.identity.workspaceId"
        in list_projects_service
        and 'throw new ProjectsError("workspace_not_found")' in list_projects_service
    )
    m12_mcp_reauth = (
        "await authenticate(request)" in mcp_src
        and 'kind: "agent"' in mcp_src
        and "tool.input.parse(rawArgs)" in mcp_src
    )
    tool_names = re.findall(r'name: "([a-z_]+)"', tools_src)
    m12_tools_exist = all(
        name in tool_names
        for name in [
            "list_projects", "list_issues", "create_issue", "update_issue", "create_comment",
            "list_activity", "list_knowledge", "create_knowledge", "update_knowledge",
        ]
    )
    m12_no_admin_tools = all(
        not any(word in name for word in ["member", "invit", "workspace", "access", "setting", "key", "admin", "grant"])
        for name in tool_names
    )
    list_projects_rest = slice_between(proj_rest_src, "app.openapi(listProjects,", "  });")
    create_project_rest = slice_between(proj_rest_src, "app.openapi(createProject,", "  });")
    set_access_rest = slice_between(proj_rest_src, "app.openapi(setProjectAccess,", "  });")
    m12_rest_bearer = (
        "await workActor(c)" in list_projects_rest
        and "agentAuthenticator(c.req.raw)" in proj_rest_src
        and 'if (identity !== null) return { kind: "agent", identity };' in proj_rest_src
        and "isAgentError(error)" in proj_rest_src
    )
    m12_rest_admin_session = (
        "await workActor(c)" not in create_project_rest
        and "await workActor(c)" not in set_access_rest
        and "await sessionReader(c)" in create_project_rest
        and "await sessionReader(c)" in set_access_rest
    )

    # M13: history visibility boundaries (#32). Each guard is read from the decision that
    # produces it: the three service methods, the installation projection, and the thin
    # REST adapter. A missing scope check or a leaked secret field flips an attempt below.
    hist_ws_fn = slice_between(hist_src, "async workspaceHistory(", "async projectHistory(")
    hist_proj_fn = slice_between(hist_src, "async projectHistory(", "async installationHistory(")
    hist_inst_fn = hist_src.split("async installationHistory(", 1)[1] if "async installationHistory(" in hist_src else ""
    hist_install_fn = slice_between(hist_src, "async function loadInstallationEvents(", "export interface HistoryDeps")
    hist_key_fn = slice_between(hist_src, "async function loadKeyEvents(", "async function loadProjectAccessEvents(")

    m13_session_only = (
        hist_rest.count("await sessionReader(c)") >= 3
        and "agentAuthenticator" not in hist_rest
        and "readBearerToken" not in hist_rest
    )
    m13_workspace_404 = (
        'throw new HistoryError("workspace_not_found")' in hist_ws_fn
        and "workspaceMemberships" in hist_ws_fn
    )
    m13_delegate_scope = (
        'throw new HistoryError("workspace_history_forbidden")' in hist_ws_fn
        and "row.canManageMemberPermissions !== true" in hist_ws_fn
        and "eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage)" in hist_ws_fn
    )
    m13_owner_keys = (
        "if (isOwner) {" in hist_ws_fn
        and "loadKeyEvents(" in hist_ws_fn
        and "loadKeyEvents(" not in hist_ws_fn.split("if (isOwner) {", 1)[0]
    )
    m13_project_404 = (
        'throw new HistoryError("project_not_found")' in hist_proj_fn
        and "ceiling.get(projectId)" in hist_proj_fn
    )
    m13_manage_access = "projectAccessAtLeast(level, ProjectAccessLevel.enum.manage)" in hist_proj_fn
    m13_activity_granted = ordered(
        hist_proj_fn, "const events = await loadProjectActivity(", "projectAccessAtLeast("
    )
    m13_admin_only = (
        "isSystemAdministrator" in hist_inst_fn
        and 'throw new HistoryError("not_system_administrator")' in hist_inst_fn
    )
    m13_installation_scope = (
        "from(instanceSetup)" in hist_install_fn
        and "from(invitations)" in hist_install_fn
        and not any(
            table in hist_install_fn
            for table in [
                "workspaceEvents", "projectAccessEvents", "projectActivity",
                "agentKeyEvents", "workspaceMemberships",
            ]
        )
    )
    m13_no_secret = not re.search(
        r"(secret|tokenHash|token_hash|passwordHash|password_hash|smtpPassword)\s*:",
        hist_contract + hist_key_fn + hist_install_fn,
    )
    # M14 (#34): runs and child workers. Identity is the authenticated agent plus the
    # harness's native session id, enforced by a partial unique index. The whole report
    # mutation runs in one transaction under a FOR UPDATE row lock, so concurrent model
    # reports cannot duplicate history or drop a child update. Reported metadata is
    # stored as reported (or null) and a report never leases.
    run_src = read_text("apps/server/src/features/runs/service.ts")
    run_mcp_src = read_text("apps/server/src/features/runs/mcp.ts")
    run_rest_src = read_text("apps/server/src/features/runs/rest.ts")
    run_contract_src = read_text("packages/contract/src/runs.ts")
    mig_0019 = read_text("db/migrations/0019_perpetual_wallop.sql")
    runs_table = slice_between(ag_schema, "export const runs = pgTable(", "// Model values observed")
    children_table = slice_between(ag_schema, "export const runChildren = pgTable(", "// An issue in a project.")
    report_fn = slice_between(run_src, "async report(identity, input)", "async listWorkspaceRuns(")
    list_runs_fn = slice_between(run_src, "async listWorkspaceRuns(", "  };\n}")
    child_fn = slice_between(run_src, "async function recordChild(", "export function createRunsService")

    m14_db_identity = (
        "one_run_per_agent_workspace_harness_session" in runs_table
        and "is not null and" in runs_table
        and "coalesce" not in runs_table
        and 'CREATE UNIQUE INDEX "one_run_per_agent_workspace_harness_session"' in mig_0019
        and "is not null and" in mig_0019
        and "coalesce" not in mig_0019
    )
    m14_identity_key = all(
        marker in report_fn
        for marker in [
            "agentId: identity.agentId",
            "workspaceId: identity.workspaceId",
            "harness: runKey.harness",
            "nativeSessionId: runKey.nativeSessionId",
        ]
    )
    m14_conflict = (
        ".onConflictDoNothing()" in report_fn
        and "eq(runs.harness, runKey.harness)" in report_fn
        and "eq(runs.nativeSessionId, runKey.nativeSessionId)" in report_fn
        and "row = created" in report_fn
    )
    m14_explicit_scope = all(
        marker in report_fn
        for marker in [
            "eq(runs.id, input.runId)",
            "eq(runs.agentId, identity.agentId)",
            "eq(runs.workspaceId, identity.workspaceId)",
            'throw new RunsError("run_not_found")',
        ]
    )
    m14_child_link = (
        "await recordChild(tx, identity, row.id, input, observedAt)" in report_fn
        and "childRunId," in child_fn
        and "agentId," in child_fn
        and "one_child_per_run_and_reported_identity" in children_table
        and "is not null or" in children_table
        and "one_child_per_run_and_reported_identity" in mig_0019
        and "is not null or" in mig_0019
        and 'FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE set null' in mig_0019
    )
    m14_child_scope = all(
        marker in child_fn
        for marker in [
            "childRunId === runId",
            "eq(runs.id, childRunId)",
            "eq(runs.agentId, identity.agentId)",
            "eq(runs.workspaceId, identity.workspaceId)",
            'throw new RunsError("run_not_found")',
            '.for("update")',
        ]
    )
    m14_serialized = (
        "db.transaction(async (tx)" in report_fn
        and 'const [locked]' in report_fn
        and 'previousModel = locked.model' in report_fn
        and '.for("update")' in report_fn
        and '.for("update")' in child_fn
    )
    m14_model_change = (
        "const modelChanged = reportedModel !== null && reportedModel !== previousModel;" in report_fn
        and "if (modelChanged && !inserted)" in report_fn
        and "fromModel: previousModel" in report_fn
        and "toModel: reportedModel" in report_fn
        and "insert(runModelChanges)" in report_fn
    )
    m14_unknown = (
        "const reportedModel = input.model ?? input.reported?.model ?? null" in report_fn
        and "runId: null," in report_fn
        and "harness: null," in report_fn
        and "harness: z.string().nullable()" in run_contract_src
        and "model: z.string().nullable()" in run_contract_src
        and "runId: z.string().nullable()" in run_contract_src
    )
    m14_reported_contract = (
        "reported:" in run_contract_src
        and "runKey: RunKey.nullable().optional()" in run_contract_src
        and "input.checkIn?.at" in report_fn
        and "input.reported?.harnessVersion" in report_fn
    )
    m14_no_lease = not any(
        word in source
        for word in ["leaseExpiresAt", "claimExpiresAt"]
        for source in [run_src, run_contract_src, run_mcp_src, mig_0019]
    )
    m14_human_scope = (
        "humanCanReadWorkspace(db, workspaceId, actor.humanId)" in list_runs_fn
        and "innerJoin(agents" in list_runs_fn
        and 'throw new RunsError("workspace_not_found")' in list_runs_fn
    )
    m14_adapters = (
        "report(identity: AgentIdentity | null, input: RunReportInput)" in run_src
        and "await authenticate(c.req.raw)" in run_rest_src
        and "await authenticate(request)" in run_mcp_src
        and "service.report(identity, c.req.valid(\"json\"))" in run_rest_src
        and "service.report(identity, parsed)" in run_mcp_src
        and "isAgentError(error)" in run_rest_src
        and "isAgentError(error)" in run_mcp_src
        and "Request" not in slice_between(run_src, "export interface RunsService", "type RunRow")
    )
    m14_tool = "orrery_run_checkin" in tool_names
    # M15 (#31): password reset and local recovery. Each guard is read from the
    # function or table that owns the decision, so deleting one produces a short
    # counterexample naming the exact API path and TS function.
    rec_src = read_text("apps/server/src/features/recovery/service.ts")
    rec_rest_src = read_text("apps/server/src/features/recovery/rest.ts")
    rec_cli_src = read_text("apps/server/src/recovery-cli.ts")
    rec_request_fn = slice_between(rec_src, "async requestReset(email)", "async confirmReset(token, password)")
    rec_confirm_fn = slice_between(rec_src, "async confirmReset(token, password)", "async localRecover(email, password)")
    rec_local_fn = slice_between(rec_src, "async localRecover(email, password)", "}")
    rec_change_fn = slice_between(rec_src, "async function changePasswordAndSignOut(", "export function createRecoveryService")
    rec_tokens_table = slice_between(schema_src := read_text("apps/server/src/db/schema.ts"), "export const passwordResetTokens = pgTable(", "// Recovery and password-reset events")
    rec_events_table = slice_between(schema_src, "export const accountRecoveryEvents = pgTable(", "// An invitation (issue #23)")
    rec_token_insert = slice_between(rec_request_fn, ".insert(passwordResetTokens)", "try {")

    m15_token_hash_only = (
        "tokenHash: tokenHash(token)" in rec_token_insert
        and '"token_hash"' in rec_tokens_table
        and '"password"' not in rec_tokens_table
        and '"secret"' not in rec_tokens_table
    )
    verified_branch = rec_request_fn.find("account.emailVerifiedAt !== null")
    deliver_at = rec_request_fn.find("await deliver(")
    m15_unverified_no_mail = (
        verified_branch >= 0 and deliver_at > verified_branch
    )
    m15_uniform_response = (
        "return { message: PASSWORD_RESET_REQUEST_MESSAGE };" in rec_request_fn
        and "return { email:" not in rec_request_fn
        and "return { humanId:" not in rec_request_fn
    )
    m15_failed_send_deletes_token = (
        "await db.delete(passwordResetTokens)" in rec_request_fn
        and "catch (error)" in rec_request_fn
    )
    m15_single_use = (
        "isNull(passwordResetTokens.usedAt)" in rec_confirm_fn
        and 'throw new RecoveryError("reset_token_invalid")' in rec_confirm_fn
    )
    m15_db_time_expiry = "gt(passwordResetTokens.expiresAt, sql`now()`)" in rec_confirm_fn
    m15_one_tx = (
        "await db.transaction(async (tx) =>" in rec_confirm_fn
        and "changePasswordAndSignOut(" in rec_confirm_fn
        and "await db.transaction(async (tx) =>" in rec_local_fn
    )
    m15_sessions_cleared = (
        "invalidateBrowserSessions(humanId, tx)" in rec_change_fn
        and "await runner.delete(browserSessions)" in acc_src
    )
    m15_agent_keys_untouched = all(
        word not in rec_change_fn and word not in rec_cli_src
        for word in ("agentApiKeys", "agentKeyEvents", "agents)", "revokeAgent")
    )
    m15_scope_untouched = all(
        word not in rec_change_fn and word not in rec_local_fn and word not in rec_cli_src
        for word in ("instanceSetup", "workspaces", "workspaceMemberships", "setupAdmin", "appointOwner")
    )
    m15_events_without_secret = (
        "insert(accountRecoveryEvents)" in rec_change_fn
        and '"token_hash"' not in rec_events_table
        and '"password"' not in rec_events_table
        and '"secret"' not in rec_events_table
        and "tokenHash:" not in rec_change_fn
    )
    m15_local_no_smtp = (
        "deliver(" not in rec_local_fn
        and "localRecover(" in rec_cli_src
        and "local recovery never sends mail" in rec_cli_src
    )
    m15_http_problems = (
        rec_rest_src.count("400: problem(") >= 2
        and rec_rest_src.count("app.openapi(") >= 2
    )
    # A password change retires every outstanding link, and local recovery is an
    # administrator-only path: the role must come from accounts and be checked here.
    m15_revokes_pending_tokens = (
        ".update(passwordResetTokens)" in rec_change_fn
        and "isNull(passwordResetTokens.usedAt)" in rec_change_fn
    )
    account_by_email_fn = slice_between(acc_src, "export async function accountByEmail(", "export async function setAccountPassword(")
    m15_admin_only_local = (
        "isSystemAdministrator: humans.isSystemAdministrator" in account_by_email_fn
        and "!account.isSystemAdministrator" in rec_local_fn
        and 'throw new RecoveryError("not_system_administrator")' in rec_local_fn
    )

    # M16 (#35): rotation. Each guard is read from the decision that owns it — the
    # service method, its thin REST route, the key tables, the migration, and the shared
    # contract — so deleting one flips the corresponding bounded attempt below.
    ag_rest = read_text("apps/server/src/features/agents/rest.ts")
    ag_contract = read_text("packages/contract/src/agents.ts")
    mig_0021 = read_text("db/migrations/0021_demonic_warstar.sql")
    rotate_fn = slice_between(ag_src, "async rotateKey(", "async listKeys(")
    rotate_prelude = rotate_fn.split("const [source]", 1)[0]
    source_select = slice_between(rotate_fn, "const [source] = await tx", ".limit(1)")
    rotate_insert = slice_between(rotate_fn, ".insert(agentApiKeys)", ".returning(")
    rotate_route = slice_between(ag_rest, "const rotateKey = createRoute(", "const listKeys = createRoute(")
    keys_table = slice_between(ag_schema, "export const agentApiKeys = pgTable(", "// The selected projects a key may act on")

    m16_serialized = "await lockWorkspaceOwnershipWrites(tx)" in rotate_prelude
    m16_source_ownership = (
        "eq(agents.humanId, actor.humanId)" in source_select
        and 'throw new AgentsError("key_not_found")' in rotate_fn
    )
    m16_revoked_refused = (
        "source.key.revokedAt !== null" in rotate_fn
        and 'throw new AgentsError("source_key_revoked")' in rotate_fn
    )
    m16_expired_refused = (
        "gt(agentApiKeys.expiresAt, sql`now()`)" in rotate_fn
        and 'throw new AgentsError("source_key_expired")' in rotate_fn
    )
    m16_workspace_access = (
        "humanCanUseWorkspace(tx, source.key.workspaceId, actor.humanId)" in rotate_fn
        and 'throw new AgentsError("workspace_not_found")' in rotate_fn
    )
    m16_same_agent_workspace = (
        "agentId: source.key.agentId" in rotate_insert
        and "workspaceId: source.key.workspaceId" in rotate_insert
        and "replacesKeyId: keyId" in rotate_insert
    )
    m16_independent_secret = (
        "const secret = newSecret()" in rotate_fn
        and "tokenHash: tokenHash(secret)" in rotate_insert
        and "tokenHash" not in source_select
        and "secret:" not in rotate_insert
    )
    m16_independent_expiry = (
        "expiresAt: expiryFor(validity)" in rotate_insert
        and "now() + make_interval(days =>" in ag_src
        and "expiresAt: source" not in rotate_insert
    )
    m16_grants_capped = (
        "projectAccessCeiling(" in rotate_fn
        and "projectAccessAtLeast(humanLevel, grant.level)" in rotate_fn
        and "level: humanLevel" in rotate_fn
        and 'throw new AgentsError("invalid_key_grant")' in rotate_fn
    )
    m16_no_cascade = (
        '"replaces_key_id"' in keys_table
        and 'onDelete: "set null"' in keys_table
        and "ON DELETE set null" in mig_0021
        and "ON DELETE CASCADE" not in mig_0021
    )
    m16_event = (
        "AgentKeyEventType.enum.agent_key_rotated" in rotate_fn
        and '"agent_key_rotated"' in ag_contract
        and "insert(agentKeyEvents)" in record_fn
        and m11_events_without_secret
    )
    m16_history_surface = (
        "type: row.type" in hist_key_fn
        and "loadKeyEvents(" in hist_ws_fn
        and '"agent_key_rotated"' in ag_contract
    )
    m16_http_problems = (
        "400: problem(" in rotate_route
        and "409: problem(" in rotate_route
        and "201:" in rotate_route
    )
    # M17 (#36): work sessions, claims and five-minute leases. Every guard is read from
    # the service, the fenced projects write, the schema/migration and the adapters, so
    # removing a row lock, the unique index, the lazy expiry or the session gate flips the
    # model to a shortest counterexample naming the exact TS function.
    sess_src = read_text("apps/server/src/features/work-sessions/service.ts")
    sess_rest_src = read_text("apps/server/src/features/work-sessions/rest.ts")
    sess_mcp_src = read_text("apps/server/src/features/work-sessions/mcp.ts")
    sess_index_src = read_text("apps/server/src/features/work-sessions/index.ts")
    mig_0021 = read_text("db/migrations/0022_spooky_barracuda.sql")
    lock_issue_fn = slice_between(sess_src, "async function lockIssue(", "// Lazy expiry")
    expire_fn = slice_between(sess_src, "async function expireStale(", "const fiveMinutes")
    claim_fn = slice_between(sess_src, "async claim(actor, input)", "async renew(actor, issueId)")
    renew_fn = slice_between(sess_src, "async renew(actor, issueId)", "async progress(actor, issueId, summary)")
    live_fn = slice_between(sess_src, "const withLiveSession = async (", "return {")
    ready_fn = slice_between(sess_src, "async readyWork(actorArg, projectId)", "async agentHoldsSession(")
    gate_fn = slice_between(sess_src, "async agentHoldsSession(", "};\n}")
    update_issue_fn = slice_between(proj_src, "async updateIssue(actorArg, issueId, input)", "async listComments(")
    work_sessions_table = slice_between(schema_src, "export const workSessions = pgTable(", "// A basic Markdown knowledge entry")

    m17_unique_index = (
        "one_active_work_session_per_issue" in mig_0021
        and "one_active_work_session_per_issue" in work_sessions_table
    )
    m17_issue_lock = (
        '.for("update")' in lock_issue_fn
        and "lockIssue(tx" in claim_fn
        and "lockIssue(tx" in live_fn
        and '.for("update")' in update_issue_fn
    )
    m17_lazy_expiry = (
        "lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in expire_fn
        and "status: WorkSessionStatus.enum.expired" in expire_fn
        and "expireStale(tx" in claim_fn
        and "expireStale(tx" in live_fn
    )
    m17_db_time_lease = "statement_timestamp() + interval '5 minutes'" in sess_src
    m17_progress_independent = (
        '"progress"' in work_sessions_table
        and "progress:" not in expire_fn
        and "progressUpdatedAt:" not in expire_fn
    )
    m17_fenced_write = (
        "sessionGate(tx, actor.identity.agentId" in update_issue_fn
        and 'throw new ProjectsError("session_required")' in update_issue_fn
        and "agentHoldsSession:" in sess_index_src
    )
    m17_gate_no_claim = (
        "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in gate_fn
        and "eq(workSessions.status, WorkSessionStatus.enum.active)" in gate_fn
        and ".insert(workSessions)" not in gate_fn
        and "claim(" not in gate_fn
    )
    # The gate runs inside projects' already issue-locked transaction; a second
    # db.transaction there would take another pool connection and can starve/deadlock.
    m17_no_nested_tx = (
        "expireCommitted(" not in gate_fn
        and "db.transaction(" not in gate_fn
    )
    m17_renew_active = (
        "eq(workSessions.status, WorkSessionStatus.enum.active)" in live_fn
        and 'throw new SessionsError("session_required")' in live_fn
    )
    m17_recheck_access = (
        "requireAccess(" in live_fn
        and "projectAccessCeiling" in sess_src
        and '"insufficient_access"' in sess_src
    )
    m17_session_identity = (
        "agentId: identity.agentId" in claim_fn
        and "runId: input.runId" in claim_fn
        and "workspaceId: identity.workspaceId" in claim_fn
        and "keyId" not in claim_fn
    )
    m17_helper_shares = (
        "isSameRun(existing, identity, input.runId)" in claim_fn
        and "return toSession(existing)" in claim_fn
    )
    m17_ready_db_time = (
        "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in ready_fn
        and "eq(issues.needsInput, false)" in ready_fn
        and "isNull(workSessions.id)" in ready_fn
    )
    m17_unfenced = (
        "sessionGate(tx" in update_issue_fn
        and proj_src.count("sessionGate(") == 1
    )
    m17_adapters = (
        "await authenticate(request)" in sess_mcp_src
        and "isAgentError(error)" in sess_rest_src
        and "SessionsError" in sess_rest_src
    )

    # M18 (#40): resume, progress retention, reacquisition and stale-session rejection.
    # Each guard is read from the function that owns the decision, so a deleted guard
    # produces a short counterexample naming the exact operation and TS function.
    sess_contract = read_text("packages/contract/src/sessions.ts")
    resume_fn = slice_between(sess_src, "async resume(actor, input)", "async reacquire(actor, input)")
    reacquire_fn = slice_between(sess_src, "async reacquire(actor, input)", "async getSession(actorArg, issueId)")
    renew_only_fn = slice_between(sess_src, "async renew(", "async progress(")
    progress_only_fn = slice_between(sess_src, "async progress(", "async stop(")
    stop_only_fn = slice_between(sess_src, "async stop(", "async resume(")
    session_columns_fn = slice_between(sess_src, "const sessionColumns =", "const iso =")

    m18_resume_read_only = (
        'accessMode: "read only"' in resume_fn
        and "expireCommitted(" not in resume_fn
        and "expireStale(" not in resume_fn
    )
    m18_resume_db_time = (
        '"expired"' in resume_fn
        and "effectiveStatus" in session_columns_fn
        and "statement_timestamp()" in session_columns_fn
    )
    m18_resume_keeps_progress = "session: toSession(row)" in resume_fn and "progress" in session_columns_fn
    m18_stale_rejected = all(
        "withLiveSession(" in fn
        for fn in (renew_only_fn, progress_only_fn, stop_only_fn)
    ) and 'throw new SessionsError("session_required")' in live_fn
    m18_db_time_liveness = (
        "lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in expire_fn
        and "expireStale(tx" in live_fn
        and "expireCommitted(issueId)" in sess_src
    )
    m18_reacquire_available = (
        "const active = await findActive(tx, issue.id)" in reacquire_fn
        and "issue.needsInput" in reacquire_fn
        and 'throw new SessionsError("issue_claimed")' in reacquire_fn
        and 'throw new SessionsError("issue_blocked")' in reacquire_fn
    )
    m18_reacquire_expired_only = (
        "prior.status !== WorkSessionStatus.enum.expired" in reacquire_fn
        and 'throw new SessionsError("session_required")' in reacquire_fn
    )
    m18_reacquire_carries_progress = (
        "progress: prior.progress" in reacquire_fn
        and "progressUpdatedAt: prior.progressUpdatedAt" in reacquire_fn
    )
    m18_reacquire_fresh_session = (
        "id: randomUUID()" in reacquire_fn and "leaseExpiresAt: fiveMinutes" in reacquire_fn
    )
    m18_idempotent = (
        "isSameRun(existing, identity, input.runId)" in claim_fn
        and "isSameRun(active, identity, input.runId)" in reacquire_fn
        and "return toSession(active)" in reacquire_fn
    )
    m18_adapters = (
        "resume_work_session" in sess_mcp_src
        and "reacquire_issue" in sess_mcp_src
        and "resume_work_session" in tools_src
        and "reacquire_issue" in tools_src
        and "ResumeWorkSessionInput" in sess_contract
    )
    m18_http_problems = (
        'path: "/api/issues/{issueId}/work-sessions/resume"' in sess_rest_src
        and 'path: "/api/issues/{issueId}/work-sessions/reacquire"' in sess_rest_src
        and sess_rest_src.count("400: problem(") >= 7
    )
    active_fn = slice_between(sess_src, "async function findActive(", "function requireAccessArgs")
    m18_session_fence = (
        "eq(workSessions.id, sessionId)" in live_fn
        and "sessionId: SessionFence.optional()" in sess_contract
        and "sessionFence(args)" in sess_mcp_src
    )
    m18_closed_refused = 'issue.status !== "open"' in reacquire_fn
    m18_update_db_time = all(
        "liveLease," in fn for fn in (renew_only_fn, progress_only_fn, stop_only_fn)
    )
    m18_find_active_db_time = "liveLease," in active_fn
    m17_tools = all(
        name in tools_src
        for name in (
            "claim_issue",
            "renew_claim",
            "report_progress",
            "stop_session",
            "get_work_session",
            "ready_work",
            "list_work_sessions",
        )
    )
    m17_problems = sess_rest_src.count("400: problem(") >= 5

    # M18 (#37): member removal / voluntary leave versus an in-flight claim renewal.
    # Every decision is read from the live workspaces, work-sessions, agents, projects and
    # REST sources plus the schema/migration, so deleting the release call, the membership
    # recheck, the issue lock order, the last-owner guard or the distinct leave events
    # flips the model to a shortest counterexample naming the exact request.
    ws_rest_src = read_text("apps/server/src/features/workspaces/rest.ts")
    ws_registry_src = read_text("apps/server/src/features/index.ts")
    mig_0023 = read_text("db/migrations/0023_wealthy_silvermane.sql")
    # The cleanup facts are read from the shared tail defined above, and the two call
    # sites are checked separately.
    remove_member_fn = slice_between(ws_src, "async removeMember(", "async leaveWorkspace(")
    leave_fn = slice_between(ws_src, "async leaveWorkspace(", "  };\n}")
    release_fn = slice_between(sess_src, "export async function releaseMemberWorkSessions(", "\n}\n")
    require_access_fn = slice_between(sess_src, "function requireAccessArgs(", "export function createSessionsService(")
    lock_access_fn = slice_between(sess_src, "async function lockAgentWorkspaceAccess(", "// Workspace removal/leave ends")
    workspace_event_types = slice_between(schema_src, "export const workspaceEventTypes = [", "] as const;")

    m18_release_in_remove = (
        "endMembership(" in remove_member_fn
        and "releaseMemberWorkSessions(tx, workspaceId, humanId)" in end_membership_fn
    )
    m18_release_in_leave = (
        "endMembership(" in leave_fn
        and "releaseMemberWorkSessions(tx, workspaceId, humanId)" in end_membership_fn
    )
    m18_active_only = "eq(workSessions.status, WorkSessionStatus.enum.active)" in release_fn
    m18_release_status_guard = ordered(
        release_fn,
        ".update(workSessions)",
        "eq(workSessions.status, WorkSessionStatus.enum.active)",
    )
    m18_membership_lock = (
        '.for("key share")' in lock_access_fn
        and 'throw new SessionsError("insufficient_access")' in lock_access_fn
        and ordered(claim_fn, "lockAgentWorkspaceAccess(tx, identity)", "lockIssue(tx")
        and ordered(live_fn, "lockAgentWorkspaceAccess(tx, identity)", "lockIssue(tx")
    )
    m18_issue_lock_order = (
        ordered(
            release_fn,
            ".select({ id: workSessions.id, issueId: workSessions.issueId })",
            '.for("update")',
            ".update(workSessions)",
        )
        and ".orderBy(issues.id)" in release_fn
        and "status: WorkSessionStatus.enum.released" in release_fn
    )
    m18_no_nested_tx = "db.transaction(" not in release_fn
    m18_recheck_membership = "humanStillHasWorkspaceAccess(tx, project.workspaceId, humanId)" in require_access_fn
    m18_personal_scope = "workspace.personalOwnerHumanId === humanId" in sess_src
    m18_revoke_keys = (
        "revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
        and "endMembership(" in remove_member_fn
        and "endMembership(" in leave_fn
    )
    m18_revoke_grants = (
        "revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId)" in end_membership_fn
        and "endMembership(" in remove_member_fn
        and "endMembership(" in leave_fn
    )
    m18_last_owner_leave = 'throw new WorkspacesError("last_owner")' in leave_fn
    m18_personal_not_leavable = "lockWorkspaceForMutation(tx, workspaceId)" in leave_fn
    m18_distinct_events = (
        '"member_left"' in workspace_event_types
        and '"owner_left"' in workspace_event_types
        and '"member_left"' in leave_fn
        and '"owner_left"' in leave_fn
        and "member_left" in mig_0023
        and "owner_left" in mig_0023
    )
    m18_single_tx = "db.transaction(" in remove_member_fn and "db.transaction(" in leave_fn
    m18_attribution_kept = (
        "delete(workspaceMemberships)" in end_membership_fn
        and end_membership_fn.count(".delete(") == 1
    )
    m18_leave_route = (
        'path: "/api/workspaces/{workspaceId}/leave"' in ws_rest_src
        and "leaveKinds" in ws_rest_src
        and "400: problem(" in ws_rest_src
        and "sessions.releaseMemberWorkSessions" in ws_registry_src
    )
    # M20 (#41): the verified three-resolution question lifecycle. Every guard is read from
    # the inbox service, its REST/MCP adapters, the contract/schema/migration and the work
    # session renewal path. Removing a row lock, the DB-time boundary, the pause transition,
    # the needs_input sync or the human-only answer gate flips the model to a shortest trace.
    q_src = read_text("apps/server/src/features/inbox/service.ts")
    q_rest_src = read_text("apps/server/src/features/inbox/rest.ts")
    q_mcp_src = read_text("apps/server/src/features/inbox/mcp.ts")
    q_contract = read_text("packages/contract/src/questions.ts")
    q_migration = read_text("db/migrations/0024_white_rage.sql")
    index_src = read_text("apps/server/src/features/index.ts")
    q_lock_fn = slice_between(q_src, "async function lockIssue(", "// Record the question")
    q_ask_fn = slice_between(q_src, "async ask(actorArg, input)", "async answer(actorArg")
    q_answer_fn = slice_between(q_src, "async answer(actorArg", "async list(actorArg")
    q_eval_fn = slice_between(q_src, "const evaluateDeadline", "const questionDeadline")
    q_deadline_fn = slice_between(q_src, "const questionDeadline", "export function createInboxService")
    sess_claim_fn = slice_between(sess_src, "async claim(actor, input)", "async renew(actor, issueId")
    sess_renew_fn = slice_between(sess_src, "async renew(actor, issueId", "async progress(actor, issueId")

    m20_statuses = (
        all(s in q_contract for s in ("open", "answered", "paused", "fallback_used"))
        and "'open', 'answered', 'paused', 'fallback_used'" in q_migration
        and "timed_out" not in q_contract
        and "timed_out" not in q_src
    )
    m20_issue_lock = (
        '.for("update")' in q_lock_fn
        and "lockIssue(tx" in q_ask_fn
        and "lockIssue(tx" in q_answer_fn
        and ".for(" in q_answer_fn
    )
    m20_db_time = (
        "lte(questions.responseDeadlineAt, sql`statement_timestamp()`)" in q_eval_fn
        and "evaluateDeadline(tx, issue.id)" in q_answer_fn
        and "statement_timestamp()" in q_answer_fn
        and "interval '1 hour'" in q_ask_fn
    )
    m20_exact_once = (
        "questions.status} in ('open', 'paused')" in q_answer_fn
        and 'throw new InboxError("question_resolved")' in q_answer_fn
    )
    m20_release_pause = (
        'status: "paused"' in q_eval_fn
        and 'status: "released"' in q_eval_fn
        and "needsInput: true" in q_eval_fn
    )
    m20_paused_unblock = (
        "needsInput: false" in q_answer_fn
        and "'open', 'paused'" in q_answer_fn
        and "throw new InboxError(\"question_resolved\")" in q_answer_fn
    )
    m20_needs_sync = (
        "needsInput: true" in q_ask_fn
        and "needsInput: true" in q_eval_fn
        and "needsInput: false" in q_answer_fn
        and "eq(issues.needsInput, false)" in ready_fn
    )
    m20_no_nested = (
        "db.transaction(" not in q_eval_fn
        and "db.transaction(" not in q_deadline_fn
        and "db.transaction(" not in q_lock_fn
    )
    m20_human_only = (
        'throw new InboxError("agents_cannot_answer")' in q_answer_fn
        and "ProjectAccessLevel.enum.contribute" in q_answer_fn
        and "agents_cannot_answer" in q_rest_src
        and "await authenticate(c.req.raw)" in q_rest_src
        and "sessionReader(c)" in q_rest_src
    )
    m20_email_after_commit = (
        "deps.deliver(" in q_ask_fn
        and q_ask_fn.index("deps.deliver(") > q_ask_fn.index("db.transaction(")
    )
    m20_history = all(
        code in q_src
        for code in ("issue_question_asked", "issue_question_answered", "issue_question_paused")
    )
    m20_claim_bounded = (
        "least(" in sess_renew_fn
        and "statement_timestamp()" in sess_renew_fn
        and "needsInput" in sess_claim_fn
        and "questionLeaseDeadline" in index_src
        and "evaluateQuestionDeadline" in index_src
    )
    m20_adapters = (
        "ask_for_input" in tools_src
        and "ask_for_input" in q_mcp_src
        and q_rest_src.count("400: problem(") >= 4
    )
    # The follow-up guards added after review: consistent lock order, non-enumeration,
    # workspace-scoped reads, DB-time effective status, ask scope, the boundary guard and
    # an MCP read tool for the answer.
    sess_deadline_fn = slice_between(sess_src, "const deadlineCommitted", "// Renew, progress")
    q_columns_fn = slice_between(q_src, "const questionColumns = {", "const iso")
    q_require_fn = slice_between(q_src, "async function requireAccess(", "function requireAgent")
    q_list_fn = slice_between(q_src, "async list(actorArg)", "async issueHistory(actorArg")
    q_history_fn = slice_between(q_src, "async issueHistory(actorArg", "    questionDeadline,")
    m20_lock_order = (
        '.for("update")' in sess_deadline_fn
        and sess_deadline_fn.index('.for("update")') < sess_deadline_fn.index("checkDeadline(tx, issueId)")
    )
    m20_non_enumeration = "if (effective === null) throw new InboxError(missing)" in q_require_fn
    m20_scoped_list = (
        "workspaceMemberships" in q_list_fn
        and "await Promise.all(" not in q_list_fn
        and "inArray(questions.projectId" in q_list_fn
        and ".slice(0, 200)" in q_list_fn
    )
    m20_db_time_reads = (
        "effectiveStatus:" in q_columns_fn
        and "select(questionColumns)" in q_list_fn
        and "select(questionColumns)" in q_history_fn
    )
    m20_ask_scope = (
        "eq(workSessions.runId, input.runId)" in q_ask_fn
        and 'issue.status !== "open"' in q_ask_fn
    )
    m20_boundary_guard = (
        "gt(questions.responseDeadlineAt, sql`statement_timestamp()`)" in q_answer_fn
        and "isNull(questions.followUp)" in q_answer_fn
    )
    m20_read_tool = "list_issue_questions" in tools_src and "list_issue_questions" in q_mcp_src
    m20_feature_seams = (
        "inbox.questionDeadline" in index_src
        and "inbox.evaluateDeadline" in index_src
        and "inbox.service." not in index_src
    )


    # M18: personal-to-shared transfer (#39). Every guard below is read from the live
    # transfer service, adapter, contract and generated migration, so deleting a lock,
    # a recheck, a cleanup write or the preview flips the model to its buggy branch.
    tr_src = read_text("apps/server/src/features/transfers/service.ts")
    tr_rest = read_text("apps/server/src/features/transfers/rest.ts")
    tr_contract = read_text("packages/contract/src/transfers.ts")
    mig_0023 = read_text("db/migrations/0025_thick_valeria_richards.sql")
    accept_fn = slice_between(
        tr_src, "async function acceptInTransaction(", "\nexport function createTransfersService"
    )
    preview_impl = tr_src.split("async preview(", 1)[1].split("async authorize(", 1)[0]
    authorize_impl = tr_src.split("async authorize(", 1)[1].split("async receiverPreview(", 1)[0]
    receiver_preview_impl = tr_src.split("async receiverPreview(", 1)[1].split("async accept(", 1)[0]
    accept_impl = tr_src.split("async accept(", 1)[1].split("async complete(", 1)[0]
    complete_impl = tr_src.split("async complete(", 1)[1]

    m21_source_owner = (
        "eq(workspaces.kind, WorkspaceKind.enum.personal)" in tr_src
        and "eq(workspaces.personalOwnerHumanId, humanId)" in tr_src
    )
    # Authorization needs only source ownership: a destination authority is not *required*
    # at authorize time, which is what makes the two-party flow possible. It may be read
    # to decide whether the authorizer is also the receiver, but it must not gate authorize.
    m21_two_party = (
        'throw new TransfersError("destination_authority_required")' not in authorize_impl
    )
    m21_dest_authority = "membership.isOwner || membership.canCreateProjects" in tr_src
    m21_recheck_source = (
        'throw new TransfersError("source_authority_lost")' in accept_fn
        and "source.personalOwnerHumanId !== auth.authorizedByHumanId" in accept_fn
    )
    m21_recheck_authority = (
        "hasCreateProjectsAuthority(tx, destination.id, acceptorHumanId)" in accept_fn
    )
    m21_recheck_workspace = (
        'throw new TransfersError("transfer_stale")' in accept_fn
        and "project.workspaceId !== auth.sourceWorkspaceId" in accept_fn
    )
    m21_active_work = (
        'eq(workSessions.status, "active")' in accept_fn
        and "workSessions.leaseExpiresAt" in accept_fn
    )
    m21_db_time_live = "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in accept_fn
    m21_db_time_expiry = (
        "gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`)" in accept_fn
    )
    m21_single_tx = tr_src.count("db.transaction(") >= 4 and "db.transaction(" not in accept_fn
    m21_lock_first = all(
        ordered(fn, "db.transaction(async (tx) => {", "await lockOwnershipWrites(tx);")
        for fn in (authorize_impl, accept_impl, complete_impl)
    )
    m21_guard_order = "ids.toSorted()" in tr_src and ordered(
        accept_fn,
        "await bumpGuards(tx, [source.id, destination.id]);",
        '.for("update")',
    )
    m21_issue_lock = ordered(
        accept_fn, "from(issues)", '.for("update")', "workSessions.leaseExpiresAt"
    )
    m21_key_cleanup = "tx.delete(agentApiKeyProjects)" in accept_fn
    m21_grant_cleanup = "tx.delete(projectAccessGrants)" in accept_fn
    m21_offer_cleanup = ".delete(workspaceInvitationGrants)" in accept_fn
    m21_grant_rebuild = (
        "tx.insert(projectAccessGrants).values" in accept_fn
        and 'level: "manage"' in accept_fn
        and "async function manageRecipients(" in tr_src
    )
    m21_grant_events = (
        "tx.insert(projectAccessEvents).values" in accept_fn
        and "ProjectAccessEventType.enum.project_access_granted" in accept_fn
    )
    m21_receipt_events = (
        all(
            event_type in tr_src
            for event_type in (
                "project_transfer_authorized",
                "project_transfer_received",
                "project_transferred_out",
            )
        )
        and '"project_transfer_received"' in accept_fn
        and '"project_transferred_out"' in accept_fn
    )
    m21_source_events_scoped = (
        ordered(accept_fn, "workspaceEvent(", "source.id,", '"project_transferred_out"')
        and '"project_transferred_out"' in accept_fn
    )
    m21_preserve_identity = (
        "set({ workspaceId: destination.id })" in accept_fn
        and ".set({ createdBy" not in accept_fn
        and "createdByHumanId:" not in accept_fn
    )
    m21_preview = (
        "TransferPreview" in tr_contract
        and "activeWork" in tr_contract
        and "accessChanges" in tr_contract
        and "/transfer/preview" in tr_rest
    )
    m21_http_problems = tr_rest.count("400: problem(") >= 4
    m21_human_only = "sessionReader" in tr_rest and "agentAuthenticator" not in tr_rest
    m21_authorization_persisted = (
        'CREATE TABLE "project_transfer_authorizations"' in mig_0023
        and "token_hash" in mig_0023
    )
    # Destination non-enumeration and the receiver's own pre-confirmation view.
    m21_dest_membership_preview = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in preview_impl
    )
    m21_dest_membership_complete = (
        "requireDestinationMember(tx, destinationWorkspaceId, account.humanId)" in complete_impl
    )
    m21_authorize_redaction = (
        "canSeeDestination ? fullPreview : null" in authorize_impl
        and "hasDestinationMembership(" in authorize_impl
    )
    m21_receiver_preview = (
        "/api/transfers/preview" in tr_rest
        and "receiverPreviewTransfer" in tr_rest
        and "async receiverPreview(" in tr_src
    )
    m21_receiver_authority = (
        "hasDestinationMembership(" in receiver_preview_impl
        and "hasCreateProjectsAuthority(" in receiver_preview_impl
        and 'throw new TransfersError("destination_authority_required")' in receiver_preview_impl
    )
    m21_accept_membership = (
        "hasDestinationMembership(tx, auth.destinationWorkspaceId, acceptorHumanId)" in accept_fn
    )
    m21_receiver_recipient = (
        "const receiver = (await hasCreateProjectsAuthority" in preview_impl
        and "const receiver = (await hasCreateProjectsAuthority" in authorize_impl
    )
    # Acceptance cleanup that keeps no stale leases, settled offers or rival tokens.
    m21_expire_lapsed = 'status: "expired"' in accept_fn and "lte(workSessions.leaseExpiresAt" in accept_fn
    m21_pending_offers_only = "eq(workspaceInvitations.status, InvitationStatus.enum.pending)" in accept_fn
    m21_revoke_siblings = (
        'status: "revoked"' in accept_fn and "ne(projectTransferAuthorizations.id, auth.id)" in accept_fn
    )


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
        "m9_owner_stale_supersedes": m9_owner_stale_supersedes,
        "m7_endpoint_reads": m7_endpoint_reads,
        "m7_get_404": m7_get_404,
        "m7_read_membership_404": m7_read_membership_404,
        "m7_require_owner_404": m7_require_owner_404,
        "m7_require_inviter_404": m7_require_inviter_404,
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
        "m10_list_scoping": m10_list_scoping,
        "m10_dead_offer_supersedes": m10_dead_offer_supersedes,
        "m10_self_revoke": m10_self_revoke,
        "m11_revocation": m11_revocation,
        "m11_membership": m11_membership,
        "m11_issue_ceiling": m11_issue_ceiling,
        "m11_single_event": m11_single_event,
        "m11_expiry": m11_expiry,
        "m11_never_skips_expiry_only": m11_never_skips_expiry_only,
        "m11_scope": m11_scope,
        "m11_project_scope": m11_project_scope,
        "m11_ceiling": m11_ceiling,
        "m11_owner_isolation": m11_owner_isolation,
        "m11_key_hash_only": m11_key_hash_only,
        "m11_events": m11_events,
        "m11_events_without_secret": m11_events_without_secret,
        "m11_member_removal_revokes_keys": m11_member_removal_revokes_keys,
        "m11_issue_serialized": m11_issue_serialized,
        "m11_repeatable_read_auth": m11_repeatable_read_auth,
        "m11_key_project_scope_db": m11_key_project_scope_db,
        "m12_agent_scope": m12_agent_scope,
        "m12_shared_gate": m12_shared_gate,
        "m12_agent_actor": m12_agent_actor,
        "m12_actor_constraint": m12_actor_constraint,
        "m12_mcp_reauth": m12_mcp_reauth,
        "m12_tools_exist": m12_tools_exist,
        "m12_no_admin_tools": m12_no_admin_tools,
        "m12_rest_bearer": m12_rest_bearer,
        "m12_rest_admin_session": m12_rest_admin_session,
        "m12_list_scope": m12_list_scope,
        "m13_session_only": m13_session_only,
        "m13_workspace_404": m13_workspace_404,
        "m13_delegate_scope": m13_delegate_scope,
        "m13_owner_keys": m13_owner_keys,
        "m13_project_404": m13_project_404,
        "m13_manage_access": m13_manage_access,
        "m13_activity_granted": m13_activity_granted,
        "m13_admin_only": m13_admin_only,
        "m13_installation_scope": m13_installation_scope,
        "m13_no_secret": m13_no_secret,
        "m14_db_identity": m14_db_identity,
        "m14_identity_key": m14_identity_key,
        "m14_conflict": m14_conflict,
        "m14_explicit_scope": m14_explicit_scope,
        "m14_child_link": m14_child_link,
        "m14_child_scope": m14_child_scope,
        "m14_serialized": m14_serialized,
        "m14_model_change": m14_model_change,
        "m14_unknown": m14_unknown,
        "m14_reported_contract": m14_reported_contract,
        "m14_no_lease": m14_no_lease,
        "m14_human_scope": m14_human_scope,
        "m14_adapters": m14_adapters,
        "m14_tool": m14_tool,
        "m15_token_hash_only": m15_token_hash_only,
        "m15_unverified_no_mail": m15_unverified_no_mail,
        "m15_uniform_response": m15_uniform_response,
        "m15_failed_send_deletes_token": m15_failed_send_deletes_token,
        "m15_single_use": m15_single_use,
        "m15_db_time_expiry": m15_db_time_expiry,
        "m15_one_tx": m15_one_tx,
        "m15_sessions_cleared": m15_sessions_cleared,
        "m15_agent_keys_untouched": m15_agent_keys_untouched,
        "m15_scope_untouched": m15_scope_untouched,
        "m15_events_without_secret": m15_events_without_secret,
        "m15_local_no_smtp": m15_local_no_smtp,
        "m15_http_problems": m15_http_problems,
        "m15_revokes_pending_tokens": m15_revokes_pending_tokens,
        "m15_admin_only_local": m15_admin_only_local,
        "m16_serialized": m16_serialized,
        "m16_source_ownership": m16_source_ownership,
        "m16_revoked_refused": m16_revoked_refused,
        "m16_expired_refused": m16_expired_refused,
        "m16_workspace_access": m16_workspace_access,
        "m16_same_agent_workspace": m16_same_agent_workspace,
        "m16_independent_secret": m16_independent_secret,
        "m16_independent_expiry": m16_independent_expiry,
        "m16_grants_capped": m16_grants_capped,
        "m16_no_cascade": m16_no_cascade,
        "m16_event": m16_event,
        "m16_history_surface": m16_history_surface,
        "m16_http_problems": m16_http_problems,
        "m17_unique_index": m17_unique_index,
        "m17_issue_lock": m17_issue_lock,
        "m17_lazy_expiry": m17_lazy_expiry,
        "m17_db_time_lease": m17_db_time_lease,
        "m17_progress_independent": m17_progress_independent,
        "m17_fenced_write": m17_fenced_write,
        "m17_gate_no_claim": m17_gate_no_claim,
        "m17_no_nested_tx": m17_no_nested_tx,
        "m17_renew_active": m17_renew_active,
        "m17_recheck_access": m17_recheck_access,
        "m17_session_identity": m17_session_identity,
        "m17_helper_shares": m17_helper_shares,
        "m17_ready_db_time": m17_ready_db_time,
        "m17_unfenced": m17_unfenced,
        "m17_adapters": m17_adapters,
        "m17_tools": m17_tools,
        "m17_problems": m17_problems,
        "m18_resume_read_only": m18_resume_read_only,
        "m18_resume_db_time": m18_resume_db_time,
        "m18_resume_keeps_progress": m18_resume_keeps_progress,
        "m18_stale_rejected": m18_stale_rejected,
        "m18_db_time_liveness": m18_db_time_liveness,
        "m18_reacquire_available": m18_reacquire_available,
        "m18_reacquire_expired_only": m18_reacquire_expired_only,
        "m18_reacquire_carries_progress": m18_reacquire_carries_progress,
        "m18_reacquire_fresh_session": m18_reacquire_fresh_session,
        "m18_idempotent": m18_idempotent,
        "m18_adapters": m18_adapters,
        "m18_http_problems": m18_http_problems,
        "m18_session_fence": m18_session_fence,
        "m18_closed_refused": m18_closed_refused,
        "m18_update_db_time": m18_update_db_time,
        "m18_find_active_db_time": m18_find_active_db_time,
        "m19_release_in_remove": m18_release_in_remove,
        "m19_release_in_leave": m18_release_in_leave,
        "m19_active_only": m18_active_only,
        "m19_release_status_guard": m18_release_status_guard,
        "m19_membership_lock": m18_membership_lock,
        "m19_issue_lock_order": m18_issue_lock_order,
        "m19_no_nested_tx": m18_no_nested_tx,
        "m19_recheck_membership": m18_recheck_membership,
        "m19_personal_scope": m18_personal_scope,
        "m19_revoke_keys": m18_revoke_keys,
        "m19_revoke_grants": m18_revoke_grants,
        "m19_last_owner_leave": m18_last_owner_leave,
        "m19_personal_not_leavable": m18_personal_not_leavable,
        "m19_distinct_events": m18_distinct_events,
        "m19_single_tx": m18_single_tx,
        "m19_attribution_kept": m18_attribution_kept,
        "m19_leave_route": m18_leave_route,
        "m20_statuses": m20_statuses,
        "m20_issue_lock": m20_issue_lock,
        "m20_db_time": m20_db_time,
        "m20_exact_once": m20_exact_once,
        "m20_release_pause": m20_release_pause,
        "m20_paused_unblock": m20_paused_unblock,
        "m20_needs_sync": m20_needs_sync,
        "m20_no_nested": m20_no_nested,
        "m20_human_only": m20_human_only,
        "m20_email_after_commit": m20_email_after_commit,
        "m20_history": m20_history,
        "m20_claim_bounded": m20_claim_bounded,
        "m20_adapters": m20_adapters,
        "m20_lock_order": m20_lock_order,
        "m20_non_enumeration": m20_non_enumeration,
        "m20_scoped_list": m20_scoped_list,
        "m20_db_time_reads": m20_db_time_reads,
        "m20_ask_scope": m20_ask_scope,
        "m20_boundary_guard": m20_boundary_guard,
        "m20_read_tool": m20_read_tool,
        "m20_feature_seams": m20_feature_seams,
        "m21_source_owner": m21_source_owner,
        "m21_two_party": m21_two_party,
        "m21_dest_authority": m21_dest_authority,
        "m21_recheck_source": m21_recheck_source,
        "m21_recheck_authority": m21_recheck_authority,
        "m21_recheck_workspace": m21_recheck_workspace,
        "m21_active_work": m21_active_work,
        "m21_db_time_live": m21_db_time_live,
        "m21_db_time_expiry": m21_db_time_expiry,
        "m21_single_tx": m21_single_tx,
        "m21_lock_first": m21_lock_first,
        "m21_guard_order": m21_guard_order,
        "m21_issue_lock": m21_issue_lock,
        "m21_key_cleanup": m21_key_cleanup,
        "m21_grant_cleanup": m21_grant_cleanup,
        "m21_offer_cleanup": m21_offer_cleanup,
        "m21_grant_rebuild": m21_grant_rebuild,
        "m21_grant_events": m21_grant_events,
        "m21_receipt_events": m21_receipt_events,
        "m21_source_events_scoped": m21_source_events_scoped,
        "m21_preserve_identity": m21_preserve_identity,
        "m21_preview": m21_preview,
        "m21_http_problems": m21_http_problems,
        "m21_human_only": m21_human_only,
        "m21_authorization_persisted": m21_authorization_persisted,
        "m21_dest_membership_preview": m21_dest_membership_preview,
        "m21_dest_membership_complete": m21_dest_membership_complete,
        "m21_authorize_redaction": m21_authorize_redaction,
        "m21_receiver_preview": m21_receiver_preview,
        "m21_receiver_authority": m21_receiver_authority,
        "m21_receiver_recipient": m21_receiver_recipient,
        "m21_expire_lapsed": m21_expire_lapsed,
        "m21_pending_offers_only": m21_pending_offers_only,
        "m21_revoke_siblings": m21_revoke_siblings,
        "m21_accept_membership": m21_accept_membership,
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
    helper_ok = (
        facts["m7_read_membership_404"]
        and facts["m7_require_owner_404"]
        and facts["m7_require_inviter_404"]
    )
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
        # A dead offer must not lock the address for seven days even when its inviter is
        # still an owner. A fresh invite supersedes it only if the liveness check also
        # verifies the offered scope, not just the inviter's role and mailbox.
        if token == "pending" and offer_present and not scope_valid:
            if facts["m9_owner_stale_supersedes"]:
                out.append(
                    (
                        "invite: a fresh offer supersedes the owner's stale-scope offer",
                        ("invited", True, "superseded", membership, grant, resent),
                    )
                )
            else:
                out.append(
                    (
                        "invite: the owner's stale-scope offer blocks the address (invitation_pending)",
                        (project_workspace, offer_present, "blocked", membership, grant, resent),
                    )
                )
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
        if token == "blocked":
            return False, "A dead owner invitation blocked a fresh offer for seven days!"
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
        ("revokeInvitation(delegated inviter, another inviter's offer with an unmanaged project)", True, facts["m10_revoke_scope"] and project_guard),
        ("invitations(delegated inviter, history includes an offer on an unmanaged project)", True, facts["m10_list_scoping"]),
        ("invite(delegated inviter, a dead pending offer from an unauthorized inviter blocks the address)", True, facts["m10_dead_offer_supersedes"]),
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
        ("revokeInvitation(original inviter revokes their own offer after losing Manage)", False, facts["m10_self_revoke"]),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        out = []
        for idx, (label, forbidden, guard) in enumerate(attempts):
            # Forbidden attempts must be rejected; allowed attempts must commit. Both
            # directions are sensitive to the extracted guard.
            result = "rejected" if guard == forbidden else "committed"
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


def check_m11(facts: dict[str, Any]) -> CheckResult:
    # #30 agent-key stateful invariants. Every attempt is a direct call against one of
    # the service's decision points; each guard is extracted from that decision's own
    # function. BFS depth is one because the decisions are independent and each has a
    # single commit/refuse outcome, exactly like M10.
    never = facts["m11_never_skips_expiry_only"]
    ceiling = facts["m11_ceiling"]
    isolation = facts["m11_owner_isolation"]
    audit = facts["m11_events"] and facts["m11_events_without_secret"]

    # (API call in the code's own words, expected outcome, guard that produces it,
    #  outcome when the guard is missing)
    attempts: list[tuple[str, str, bool, str]] = [
        ("GET /api/agents/me with a live key in its own workspace", "authenticated", True, "rejected"),
        ("GET /api/agents/me one second before the deadline", "authenticated", facts["m11_expiry"], "rejected"),
        ("GET /api/agents/me with a Never key whose owner still has access", "authenticated", never and ceiling, "rejected"),
        ("GET /api/agents/me?workspaceId=<another workspace>", "rejected", facts["m11_scope"], "authenticated"),
        ("GET /api/agents/me?projectId=<a project outside the key>", "rejected", facts["m11_project_scope"], "authenticated"),
        ("GET /api/agents/me with a revoked key (including Never)", "rejected", facts["m11_revocation"] and never, "authenticated"),
        ("GET /api/agents/me with a 7-day key just after expiry", "rejected", facts["m11_expiry"], "authenticated"),
        ("GET /api/agents/me after the human owner left the key's workspace (Never)", "rejected", facts["m11_membership"] and never, "authenticated"),
        ("GET /api/agents/me?projectId=... after the human's level was lowered", "effective=contribute", ceiling, "effective=manage"),
        ("GET /api/agents/me?projectId=... after the human's grant was removed", "rejected", ceiling, "effective=manage"),
        ("POST /api/agents/keys with a level above the human's current access", "rejected", facts["m11_issue_ceiling"], "committed"),
        ("POST /api/agents/keys persists only the hash, never the secret", "hash_only", facts["m11_key_hash_only"], "secret_stored"),
        ("DELETE /api/workspaces/A/agent-keys/<key in A> (owner revokes another human's key)", "revoked", isolation, "rejected"),
        ("DELETE /api/workspaces/A/agent-keys/<key in B> (owner reaches across workspaces)", "rejected", isolation, "revoked"),
        ("repeating a revocation writes no second event", "events=1_no_duplicate", facts["m11_single_event"], "events=2_duplicate"),
        ("the owner's revocation in A leaves a key in B live", "live", isolation, "revoked"),
        ("creation and revocation each write one event, without a secret", "events=2_no_secret", audit, "events=0"),
        ("removeMember revokes the member's workspace keys, so rejoin cannot revive them", "revoked_on_removal", facts["m11_member_removal_revokes_keys"], "live_after_rejoin"),
        ("POST /api/agents/keys racing removeMember leaves no unrevoked key for a removed member", "no_live_key", facts["m11_issue_serialized"], "live_key_for_removed_member"),
        ("GET /api/agents/me reads membership, revocation, and ceilings in one REPEATABLE READ snapshot", "consistent", facts["m11_repeatable_read_auth"], "torn_read"),
        ("direct insert of agent_api_key_projects for a project in another workspace", "rejected", facts["m11_key_project_scope_db"], "committed"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        out = []
        for idx, (label, expected, guard, wrong) in enumerate(attempts):
            result = expected if guard else wrong
            out.append((f"{label} -> {result}", ("probed", idx, result)))
        return out

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M11",
        "Workspace-Scoped Agent API Keys (#30)",
        "Keys are scoped and revocable in one workspace, never outlive their human's access, and audit events carry no secrets",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/agents/service.ts",
            "apps/server/src/features/agents/index.ts",
            "apps/server/src/features/index.ts",
            "apps/server/src/features/workspaces/service.ts",
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0016_clumsy_masked_marvel.sql",
            "db/migrations/0018_agent_key_project_scope.sql",
        ],
    )


def check_m12(facts: dict[str, Any]) -> CheckResult:
    # #33: the same service gate decides REST and MCP; an agent key authenticates on
    # every tool call, so revocation/expiry/demotion apply immediately. Writes name the
    # agent, and neither transport exposes membership or installation administration.
    gate = facts["m12_shared_gate"]
    scope = facts["m12_agent_scope"]
    reauth = facts["m12_mcp_reauth"]
    audit = facts["m12_agent_actor"] and facts["m12_actor_constraint"]

    attempts: list[tuple[str, str, bool, str]] = [
        ("MCP create_issue with a Contribute key", "committed", gate and facts["m12_tools_exist"], "refused"),
        ("MCP edit title/body, close, and reopen with a Contribute key", "committed", gate, "refused"),
        ("MCP create_comment with a Contribute key", "committed", gate, "refused"),
        ("MCP create/update_knowledge with a Contribute key", "committed", gate, "refused"),
        ("REST work routes accept the same bearer key", "same_work_actor", gate and facts["m12_rest_bearer"], "not_signed_in"),
        ("MCP list/get issue and knowledge with a Read key", "inspected", gate, "refused"),
        ("MCP create_issue with a Read key", "refused", gate, "committed"),
        ("MCP update_issue/close with a Read key", "refused", gate, "committed"),
        ("MCP create_comment with a Read key", "refused", gate, "committed"),
        ("MCP create/update_knowledge with a Read key", "refused", gate, "committed"),
        ("REST mutation with a Read key", "refused", gate and facts["m12_rest_bearer"], "committed"),
        ("REST and MCP Read denials share one stable code", "insufficient_project_access", gate, "divergent"),
        ("MCP write on a project in another workspace", "refused", scope, "committed"),
        ("MCP write on a project outside the key grants", "refused", scope, "committed"),
        ("MCP list_projects targeting another workspace the owner belongs to", "refused", facts["m12_list_scope"], "empty_list"),
        ("REST list projects in another workspace the owner belongs to", "refused", facts["m12_list_scope"] and facts["m12_rest_bearer"], "empty_list"),
        ("MCP call with a key revoked after the client connected", "refused", reauth, "committed"),
        ("REST call with a revoked key", "refused", reauth and facts["m12_rest_bearer"], "committed"),
        ("MCP call with a key whose human grant was lowered", "refused", reauth and gate, "committed"),
        ("MCP write records the agent as actor, never its human owner", "actor=agent", audit, "actor=human"),
        ("stored issue/activity row has exactly one actor identity", "one_actor", facts["m12_actor_constraint"], "two_actors"),
        ("MCP tool list offers membership, invitation, or installation administration", "refused", facts["m12_no_admin_tools"], "exposed"),
        ("bearer key accepted on a REST project-admin or workspace/settings route", "refused", facts["m12_rest_admin_session"], "accepted"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M12",
        "Agent Project Work Through MCP (#33)",
        "One gate decides REST and MCP project work, agents are the recorded actors, a key is scoped to one workspace, and no key reaches membership or administration",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/projects/rest.ts",
            "apps/server/src/features/projects/mcp.ts",
            "apps/server/src/features/agents/auth.ts",
            "packages/contract/src/mcp-tools.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0017_rapid_talon.sql",
        ],
    )


def check_m13(facts: dict[str, Any]) -> CheckResult:
    # #32 history visibility. Every attempted read is a direct request against one of the
    # three history routes; each guard is extracted from the decision that enforces it.
    # The 4th tuple item is the outcome when the guard is missing: if a source guard is
    # removed, that attempt resolves to the wrong outcome and this check FAILS. That is
    # the sensitivity proof — positive controls below also fail if a guard over-blocks.
    attempts: list[tuple[str, str, bool, str]] = [
        # Positive controls: the entitled reader really does get the events.
        ("workspace owner reads membership, key, and project access history", "visible", facts["m13_owner_keys"], "omitted"),
        ("delegated permission manager reads workspace membership history", "visible", facts["m13_delegate_scope"], "403"),
        ("project reader sees attributed activity in a granted project", "activity", facts["m13_activity_granted"], "404"),
        ("project manager additionally sees access events in their project", "access+activity", facts["m13_manage_access"], "activity_only"),
        ("system administrator reads installation history", "visible", facts["m13_admin_only"], "403"),
        ("all three history routes use the human session reader", "session", facts["m13_session_only"], "bearer"),
        # Scope isolation: out-of-scope workspaces and projects are indistinguishable
        # from missing ones, and a delegate's project view stops at what they Manage.
        ("non-member reads another workspace's history", "404", facts["m13_workspace_404"], "200"),
        ("system administrator reads a workspace they do not belong to", "404", facts["m13_workspace_404"], "200"),
        ("ordinary member reads workspace access history", "403", facts["m13_delegate_scope"], "200"),
        ("delegated manager reads another workspace's history", "404", facts["m13_workspace_404"], "200"),
        ("delegated manager reads access events for a project they do not Manage", "omitted", facts["m13_delegate_scope"], "included"),
        ("ordinary member reads an ungranted project's history", "404", facts["m13_project_404"], "200"),
        ("system administrator reads a private project's history", "404", facts["m13_project_404"], "200"),
        ("ordinary member sees project access events in a granted project", "omitted", facts["m13_manage_access"], "included"),
        ("delegated manager reads a key event from their workspace", "omitted", facts["m13_owner_keys"], "included"),
        # Installation history carries only installation records; no private content.
        ("ordinary account reads installation history", "403", facts["m13_admin_only"], "200"),
        ("installation history includes another workspace's membership events", "absent", facts["m13_installation_scope"], "included"),
        ("installation history includes a private project's activity", "absent", facts["m13_installation_scope"], "included"),
        # Secrets never enter an event payload or a history response.
        ("history response carries a credential secret", "absent", facts["m13_no_secret"], "included"),
        ("credential event carries a token hash", "absent", facts["m13_no_secret"], "included"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M13",
        "History Visibility Boundaries (#32)",
        "Owners and delegates see in-scope access history, members only granted-project activity, administrators only installation events, out-of-scope reads are 404, and no secret is returned",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/history/service.ts",
            "apps/server/src/features/history/rest.ts",
            "packages/contract/src/history.ts",
            "apps/server/src/features/accounts/index.ts",
            "apps/server/src/features/projects/index.ts",
            "apps/server/src/db/schema.ts",
        ],
    )


def check_m15(facts: dict[str, Any]) -> CheckResult:
    # #31 password recovery and local administrator recovery. BFS over the token
    # lifecycle (issued, just before/after expiry in database time, used), delivery
    # failures, and both password-change paths. Every guard comes from the source of
    # the decision; removing one makes the corresponding forbidden state reachable.
    single_use = facts["m15_single_use"]
    db_time = facts["m15_db_time_expiry"]
    unverified_guard = facts["m15_unverified_no_mail"]
    uniform = facts["m15_uniform_response"]
    failed_send_deletes = facts["m15_failed_send_deletes_token"]
    one_tx = facts["m15_one_tx"]
    sessions_cleared = facts["m15_sessions_cleared"]
    keys_untouched = facts["m15_agent_keys_untouched"]
    scope_untouched = facts["m15_scope_untouched"]
    audit_ok = facts["m15_events_without_secret"]
    local_no_smtp = facts["m15_local_no_smtp"]
    revoke_pending = facts["m15_revokes_pending_tokens"]
    admin_only = facts["m15_admin_only_local"]

    fields = [
        "token", "verified", "smtp", "mailed", "pw_changed", "expired_used", "reused",
        "torn", "leak", "secret_event", "bootstrap", "owner", "sessions", "keys",
        "events", "smtp_dependency", "unverified_mailed", "raw_token_stored", "no_problem",
        "other_token", "non_admin_local",
    ]
    idx = {name: i for i, name in enumerate(fields)}

    def setf(state, **kwargs):
        values = list(state)
        for name, value in kwargs.items():
            values[idx[name]] = value
        return tuple(values)

    def add_event(events, kind):
        # A frozenset keeps the event space finite across repeated requests; only the
        # presence of a secret-free event matters to this model.
        return events | {kind}

    init = (
        "none", False, True, False, False, False, False, False, False, False,
        "closed", "u1", frozenset({"s1", "s2"}), frozenset({"k1"}), frozenset(),
        False, False, not facts["m15_token_hash_only"], not facts["m15_http_problems"],
        "none", False,
    )

    def next_states(state):
        out = []
        token = state[idx["token"]]

        # Environment: the separate verification flow and the administrator's relay.
        if not state[idx["verified"]]:
            out.append(("email verified by the separate verification flow", setf(state, verified=True)))
        if state[idx["smtp"]]:
            out.append(("SMTP breaks", setf(state, smtp=False)))
        else:
            out.append(("SMTP repaired", setf(state, smtp=True)))

        # Every request answers the same resource; only an eligible, verified address
        # with a working relay creates a live token and sends mail.
        for label, eligibility in (
            ("request for an unknown address", "unknown"),
            ("request for an unverified address", "unverified"),
            ("request for a verified address", "verified"),
        ):
            new = state
            if not uniform:
                new = setf(new, leak=True)
            if eligibility == "verified" and state[idx["smtp"]]:
                new = setf(
                    new,
                    token="pre",
                    mailed=True,
                    events=add_event(state[idx["events"]], "requested"),
                )
                if state[idx["pw_changed"]]:
                    # A fresh request after a password change is legitimate, not a
                    # leftover link that survived the change.
                    new = setf(new, other_token="none")
                elif token in ("pre", "post"):
                    # A second request while another link is live: two outstanding
                    # links, only one of which the confirm POST will consume.
                    new = setf(new, other_token="live")
                if not audit_ok:
                    new = setf(new, secret_event=True)
            elif eligibility == "verified" and not failed_send_deletes:
                # Mail never left, but a token row survived: an undelivered link is live.
                new = setf(new, token="pre", mailed=False)
            elif eligibility == "unverified" and not unverified_guard:
                new = setf(
                    new,
                    token="pre",
                    mailed=True,
                    unverified_mailed=True,
                    events=add_event(state[idx["events"]], "requested"),
                )
                if not audit_ok:
                    new = setf(new, secret_event=True)
            out.append((label, new))

        # The token crosses its one-hour deadline in database time.
        if token == "pre":
            out.append(("database time passes the one-hour deadline", setf(state, token="post")))

        # Redemption: a POST is the only thing that consumes the token.
        if token in ("pre", "post", "used"):
            # A fresh token redeems either way; single-use and database-time expiry are
            # what refuse the *later* attempts (reuse and post-deadline redemption).
            allowed = (
                token == "pre"
                or (token == "post" and not db_time)
                or (token == "used" and not single_use)
            )
            if allowed:
                new = setf(
                    state,
                    token="used",
                    sessions=frozenset(),
                    events=add_event(state[idx["events"]], "completed"),
                )
                if token == "post":
                    new = setf(new, expired_used=True)
                if token == "used":
                    new = setf(new, reused=True)
                if not one_tx:
                    # Token consumed but the password change did not commit with it.
                    new = setf(new, torn=True)
                else:
                    new = setf(new, pw_changed=True)
                if not sessions_cleared:
                    new = setf(new, sessions=state[idx["sessions"]])
                if not keys_untouched:
                    new = setf(new, keys=frozenset())
                if not audit_ok:
                    new = setf(new, secret_event=True)
                if revoke_pending:
                    new = setf(new, other_token="none")
                out.append(("confirmReset(token) redeems the link", new))
            else:
                out.append(("confirmReset(token) refused: invalid, expired, or used", state))
        else:
            out.append(("confirmReset(fabricated token) refused", state))

        # The local command changes the password with no email, no token, and no SMTP.
        new = setf(
            state,
            sessions=frozenset(),
            pw_changed=True,
            events=add_event(state[idx["events"]], "local"),
        )
        if not sessions_cleared:
            new = setf(new, sessions=state[idx["sessions"]])
        if not keys_untouched:
            new = setf(new, keys=frozenset())
        if not scope_untouched:
            new = setf(new, bootstrap="open", owner="u2")
        if not audit_ok:
            new = setf(new, secret_event=True)
        if not local_no_smtp:
            new = setf(new, smtp_dependency=True)
        if revoke_pending:
            new = setf(new, other_token="none")
        out.append(("local recovery changes the password with broken SMTP", new))

        # Local recovery is an administrator-only path. An ordinary human with local
        # shell access must be refused, not handed a public recovery bypass.
        if not admin_only:
            out.append(
                (
                    "local recovery invoked for an ordinary account [NOT ADMIN]",
                    setf(new, non_admin_local=True),
                )
            )
        else:
            out.append(("local recovery refused for an ordinary account", state))
        return out

    def inv(state):
        if state[idx["leak"]]:
            return False, "A recovery response revealed whether an account exists or is verified."
        if state[idx["unverified_mailed"]]:
            return False, "A password reset was mailed to an unverified address."
        if state[idx["raw_token_stored"]]:
            return False, "A raw reset token, password, or secret was stored."
        if state[idx["no_problem"]]:
            return False, "A validated recovery route does not declare a 400 Problem."
        if state[idx["secret_event"]]:
            return False, "A recovery event carried a secret, or its table can store one."
        if state[idx["expired_used"]]:
            return False, "A reset token just after its database-time deadline was redeemed."
        if state[idx["reused"]]:
            return False, "A single-use reset token was redeemed twice."
        if state[idx["torn"]]:
            return False, "A token was consumed without the password change committing with it."
        if state[idx["token"]] == "used" and not state[idx["mailed"]]:
            return False, "A token whose email never left was redeemable."
        if state[idx["pw_changed"]] and state[idx["sessions"]]:
            return False, "Prior browser sessions survived a password change."
        if state[idx["pw_changed"]] and state[idx["keys"]] != frozenset({"k1"}):
            return False, "Agent API keys were touched by a password recovery."
        if state[idx["pw_changed"]] and state[idx["other_token"]] == "live":
            return False, "An earlier unused reset link survived a password change."
        if state[idx["non_admin_local"]]:
            return False, "Local recovery was used by a non-administrator."
        if state[idx["bootstrap"]] != "closed":
            return False, "Local recovery reopened bootstrap."
        if state[idx["owner"]] != "u1":
            return False, "Local recovery changed workspace ownership."
        if state[idx["smtp_dependency"]]:
            return False, "Local recovery depended on a working SMTP relay."
        return True, ""

    return bfs_check(
        "M15",
        "Password Recovery & Local Recovery (#31)",
        "Reset links are single-use, expire in database time, and are all retired on a password change; unverified addresses are never mailed, responses never enumerate accounts, both paths end browser sessions without touching agent keys/bootstrap/ownership, and local recovery is administrator-only and works without SMTP",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/recovery/service.ts",
            "apps/server/src/features/recovery/rest.ts",
            "apps/server/src/features/accounts/service.ts",
            "apps/server/src/recovery-cli.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0020_flippant_iceman.sql",
        ],
    )


def check_m16(facts: dict[str, Any]) -> CheckResult:
    # #35 rotation. Bounded attempts over the replacement's lifecycle: every attempt is
    # a direct probe of one extracted guard, with the outcome when that guard is missing.
    # Overlap, independent expiry, old-revoke isolation, password-reset independence, and
    # the secret-free replacement event are each named in the code's own API/TS words.
    overlap = facts["m16_same_agent_workspace"] and facts["m16_independent_secret"]
    attempts: list[tuple[str, str, bool, str]] = [
        (
            "POST /api/agents/keys/<live key>/rotate creates a replacement for the same agent and workspace",
            "same_target",
            overlap and facts["m16_serialized"],
            "other_target",
        ),
        (
            "POST rotate mints a new secret and never repeats the source secret",
            "new_secret_only",
            facts["m16_independent_secret"],
            "old_secret_reused",
        ),
        (
            "Both keys authenticate during the overlap",
            "both_live",
            overlap,
            "only_source_live",
        ),
        (
            "DELETE the source key leaves the replacement authenticating",
            "new_live",
            facts["m16_no_cascade"],
            "new_revoked",
        ),
        (
            "DELETE the replacement leaves the source authenticating",
            "old_live",
            facts["m16_no_cascade"],
            "old_revoked",
        ),
        (
            "Letting the source key expire does not expire the replacement",
            "new_live",
            facts["m16_independent_expiry"],
            "new_expired",
        ),
        (
            "Letting the replacement expire does not expire the source",
            "old_live",
            facts["m16_independent_expiry"],
            "old_expired",
        ),
        (
            "The replacement expiry is computed from now, not copied from the source",
            "fresh_expiry",
            facts["m16_independent_expiry"],
            "copied_expiry",
        ),
        (
            "A password reset leaves both the source and replacement keys authenticating",
            "both_live",
            facts["m15_agent_keys_untouched"],
            "keys_swept",
        ),
        ("POST rotate on a revoked key is refused", "refused", facts["m16_revoked_refused"], "rotated"),
        (
            "POST rotate on an expired key is refused in database time",
            "refused",
            facts["m16_expired_refused"],
            "rotated",
        ),
        (
            "POST rotate on another human's key is refused",
            "refused",
            facts["m16_source_ownership"],
            "rotated",
        ),
        (
            "POST rotate on a key whose workspace the human lost is refused",
            "refused",
            facts["m16_workspace_access"],
            "rotated",
        ),
        (
            "POST rotate racing removeMember leaves no unrevoked replacement for a removed member",
            "no_orphan",
            facts["m16_serialized"],
            "orphan_key",
        ),
        (
            "Preserved grants above current human access are capped and explicit grants validated",
            "capped",
            facts["m16_grants_capped"],
            "stale_authority",
        ),
        (
            "Rotation writes one secret-free agent_key_rotated event on the replacement",
            "event_no_secret",
            facts["m16_event"],
            "no_event",
        ),
        (
            "The #32 history view surfaces agent_key_rotated without a secret",
            "surfaced",
            facts["m16_history_surface"],
            "hidden",
        ),
        (
            "The validated rotation route declares a 400 Problem",
            "problem",
            facts["m16_http_problems"],
            "no_problem",
        ),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M16",
        "Agent Key Rotation (#35)",
        "Rotation overlaps the old and new keys with independent expiry and revocation, survives a password reset, caps grants by current access, and records a secret-free event that history surfaces",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/agents/service.ts",
            "apps/server/src/features/agents/rest.ts",
            "apps/server/src/features/history/service.ts",
            "apps/server/src/features/recovery/service.ts",
            "packages/contract/src/agents.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0021_demonic_warstar.sql",
        ],
    )


def check_m14(facts: dict[str, Any]) -> CheckResult:
    # #34: run identity is isolated per agent/workspace/harness/session, a resume reuses
    # the run, children link to their parent, model changes are events, and missing
    # metadata stays unknown. Each attempt is a direct probe of one extracted guard.
    identity = facts["m14_db_identity"] and facts["m14_identity_key"]
    resume = facts["m14_conflict"]
    scope = facts["m14_explicit_scope"]
    child = facts["m14_child_link"]
    child_scope = facts["m14_child_scope"]
    serialized = facts["m14_serialized"]
    history = facts["m14_model_change"]
    unknown = facts["m14_unknown"]
    reported = facts["m14_reported_contract"]
    adapters = facts["m14_adapters"]

    attempts: list[tuple[str, str, bool, str]] = [
        ("two clients share one key but report different native session ids", "2_distinct_runs", identity, "1_shared_run"),
        ("two anonymous children of one run are reported", "2_children", facts["m14_child_link"], "1_collapsed_child"),
        ("two check-ins carry the same (harness, nativeSessionId) under one key", "1_run_resumed", resume and facts["m14_db_identity"], "2_runs"),
        ("a resume reuses an explicit runId of this agent's run", "same_run", scope, "new_run"),
        ("a report names a runId belonging to another workspace's agent", "run_not_found", scope, "run_hijacked"),
        ("child_started reports agentId/agentType on the parent run", "linked_to_parent", child, "unlinked"),
        ("a child runId points at the parent run itself", "run_not_found", child_scope, "self_loop"),
        ("a child runId names a run of another agent", "run_not_found", child_scope, "foreign_agent_link"),
        ("a child runId names a run in another workspace", "run_not_found", child_scope, "cross_workspace_link"),
        ("a repeated child event updates the same child row under a row lock", "1_child_updated", child and serialized, "update_dropped"),
        ("two simultaneous A-to-B model reports share one transaction and row lock", "history=1_no_duplicate", serialized and history, "duplicate_history"),
        ("the model changes from A to B during one run", "history=A_to_B", history, "no_history"),
        ("the same model is reported twice", "no_second_event", history, "duplicate_event"),
        ("a report omits the model", "unknown_or_unchanged", unknown, "model_cleared"),
        ("a report has no runId and no runKey", "runId=null_no_row", unknown, "transport_session_run"),
        ("harness version and model are absent on a new run", "stored_null", unknown, "synthesised"),
        ("a check-in sends reported:{model,harnessVersion} and runKey:null with a runId", "metadata_stored", reported and scope, "metadata_stripped"),
        ("a check-in omits `at` but carries checkIn.at", "observed_at_used", reported, "time_missing"),
        ("a revoked or keyless report is authenticated in the adapters", "refused", adapters, "accepted_by_service"),
        ("REST hook and MCP check-in map key failures to the same codes", "same_codes", adapters, "divergent"),
        ("a human outside the workspace lists its runs", "workspace_not_found", facts["m14_human_scope"], "listed"),
        ("the workspace view names the agent, not only its id", "agentName", facts["m14_human_scope"], "raw_id"),
        ("the run-reporting tool advertises a lease expiry or claim", "absent", facts["m14_no_lease"], "present"),
        ("orrery_run_checkin is registered on MCP", "exposed", facts["m14_tool"], "missing"),
        ("a run is attributed to the authenticated agent, never a reported name", "actor=agent", identity and adapters, "actor=reported"),
    ]
    init = ("start",)

    def next_states(state):
        if state != ("start",):
            return []
        return [
            (f"{label} -> {expected if guard else wrong}", ("probed", idx, expected if guard else wrong))
            for idx, (label, expected, guard, wrong) in enumerate(attempts)
        ]

    def inv(state):
        if state[0] != "probed":
            return True, ""
        label, expected, _, _ = attempts[state[1]]
        if state[2] != expected:
            return False, f"{label} returned {state[2]}, expected {expected}"
        return True, ""

    return bfs_check(
        "M14",
        "Runs and Child Workers (#34)",
        "Run identity is isolated per key and harness session, resumes reuse the run, children link to their parent, model changes are recorded, and unreported metadata stays unknown",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/runs/service.ts",
            "apps/server/src/features/runs/mcp.ts",
            "apps/server/src/features/runs/rest.ts",
            "packages/contract/src/runs.ts",
            "packages/contract/src/mcp-tools.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0019_perpetual_wallop.sql",
        ],
    )


def check_m17(facts: dict[str, Any]) -> CheckResult:
    """#36: one active claim per issue, DB-time five-minute expiry, progress kept, and
    fenced agent writes. Two agents (A, B) and two issues keep the state space small;
    every transition consults a guard extracted from the live service, projects fence and
    schema, so a deleted guard produces a shortest trace naming the exact operation."""
    unique = facts["m17_unique_index"]
    lock = facts["m17_issue_lock"]
    lazy = facts["m17_lazy_expiry"]
    db_time = facts["m17_db_time_lease"]
    keep_progress = facts["m17_progress_independent"]
    fenced = facts["m17_fenced_write"]
    no_claim = facts["m17_gate_no_claim"]
    no_nested = facts["m17_no_nested_tx"]
    renew_active = facts["m17_renew_active"]
    recheck = facts["m17_recheck_access"]
    identity = facts["m17_session_identity"]
    shared = facts["m17_helper_shares"]
    ready_db = facts["m17_ready_db_time"]
    unfenced = facts["m17_unfenced"]
    adapters = facts["m17_adapters"]
    tools_ok = facts["m17_tools"] and facts["m17_problems"]

    KEYS = ("owner", "status", "lease", "progress", "needs")

    def upd(sessions, i, **changes):
        rows = [dict(zip(KEYS, s)) for s in sessions]
        rows[i].update(changes)
        return tuple(tuple(row[k] for k in KEYS) for row in rows)

    def bad(violations, reason):
        return violations | {reason}

    def claim(sessions, levels, violations, who, i):
        owner, status, _, _, _ = sessions[i]
        if not lock:
            violations = bad(violations, "unserialized_claim")
        if levels[0 if who == "A" else 1] != "contribute":
            return sessions, violations
        if status == "active":
            if owner == who:
                return sessions, (violations if shared else bad(violations, "helper_duplicate_session"))
            return sessions, (violations if unique and lock else bad(violations, "two_active_sessions"))
        return upd(sessions, i, owner=who, status="active", lease="fresh"), violations

    def touch_lease(sessions, violations, state):
        """Expire a lapsed active session lazily; progress is a separate column."""
        s0, s1 = sessions
        v = violations
        for i, s in enumerate((s0, s1)):
            if s[1] == "active" and s[2] == "lapsed" and state == "expire":
                sessions = upd(sessions, i, status="expired", owner=None, lease="lapsed")
                if not keep_progress:
                    sessions = upd(sessions, i, progress="")
                    v = bad(v, "progress_erased")
        return sessions, v

    def renew(sessions, levels, violations, who, i, replacement=False):
        owner, status, lease, _, _ = sessions[i]
        v = violations
        level = levels[0 if who == "A" else 1]
        if level == "read":
            if recheck:
                return sessions, v
            # A stale identity could still renew after a downgrade: access survived.
            if status == "active" and owner == who and lease == "fresh":
                return sessions, bad(v, "renewed_after_downgrade")
            return sessions, v
        if not recheck:
            return sessions, bad(v, "renew_without_recheck")
        if status != "active" or owner != who:
            if not renew_active:
                return upd(sessions, i, owner=who, status="active", lease="fresh"), bad(v, "stale_write_became_claim")
            return sessions, v
        if lease == "lapsed":
            if not db_time or not renew_active:
                return upd(sessions, i, lease="fresh"), bad(v, "renewed_expired_claim")
            return touch_lease(sessions, v, "expire")[0], v
        if replacement and not identity:
            return sessions, bad(v, "replacement_key_refused")
        return upd(sessions, i, lease="fresh"), v

    def fenced_write(sessions, levels, violations, who, i, action):
        owner, status, lease, _, _ = sessions[i]
        v = violations
        if levels[0 if who == "A" else 1] == "read":
            return sessions, v
        if status == "active" and owner == who and lease == "fresh":
            return sessions, v
        if lease == "lapsed" and status == "active":
            if db_time and lazy and renew_active:
                sessions, v = touch_lease(sessions, v, "expire")
                return sessions, v
            return sessions, bad(v, "stale_write_accepted")
        if not fenced or not no_claim:
            return sessions, bad(v, f"{action}_without_session")
        return sessions, v

    def tick(sessions, violations):
        if not db_time:
            return sessions, violations
        rows = [dict(zip(KEYS, row)) for row in sessions]
        for row in rows:
            if row["status"] == "active":
                row["lease"] = "lapsed"
        return tuple(tuple(row[k] for k in KEYS) for row in rows), violations

    def progress(sessions, levels, violations):
        owner, status, lease, _, _ = sessions[0]
        if levels[0] == "read":
            return sessions, violations
        if status == "active" and owner == "A" and lease == "fresh":
            return upd(sessions, 0, progress="p"), violations
        if lease == "lapsed" and status == "active":
            if db_time and lazy and renew_active:
                return touch_lease(sessions, violations, "expire")
            return sessions, bad(violations, "stale_progress_accepted")
        if not fenced or not no_claim:
            return sessions, bad(violations, "progress_without_session")
        return sessions, violations

    def downgrade(sessions, levels, violations):
        return sessions, ("read", levels[1]), violations

    actions = [
        ("A claims issue 1", lambda s, l, v: claim(s, l, v, "A", 0)),
        ("B races A by claiming issue 1", lambda s, l, v: claim(s, l, v, "B", 0)),
        ("B claims issue 2 in its own run", lambda s, l, v: claim(s, l, v, "B", 1)),
        ("five minutes pass in database time", lambda s, l, v: tick(s, v)),
        ("A renews its live claim", lambda s, l, v: renew(s, l, v, "A", 0)),
        ("B renews issue 1 while A holds it", lambda s, l, v: renew(s, l, v, "B", 0)),
        ("a replacement key for A renews the same session", lambda s, l, v: renew(s, l, v, "A", 0, replacement=True)),
        ("A reports progress on issue 1", lambda s, l, v: progress(s, l, v)),
        ("A edits issue 1", lambda s, l, v: fenced_write(s, l, v, "A", 0, "edit")),
        ("A stops issue 1", lambda s, l, v: fenced_write(upd(s, 0, status="completed", owner=None) if s[0][1] == "active" and s[0][0] == "A" and s[0][2] == "fresh" else s, l, v, "A", 0, "stop")),
        ("A's grant is downgraded to Read", lambda s, l, v: downgrade(s, l, v)),
        ("A creates an issue, comment and knowledge without a session", lambda s, l, v: (s, v if unfenced else bad(v, "unfenced_refused"))),
        ("issue 1 is paused for input", lambda s, l, v: (upd(s, 0, needs=True), v)),
        ("the ready-work listing is read", lambda s, l, v: (s, v if _ready_ok(s, ready_db) else bad(v, "ready_listing_wrong"))),
        ("the five-minute lease deadline is computed in database time", lambda s, l, v: (s, v if db_time else bad(v, "lease_not_db_time"))),
        ("the fenced gate evaluates liveness on the caller's transaction", lambda s, l, v: (s, v if no_nested else bad(v, "nested_transaction_pool_starvation"))),
        ("both adapters authenticate the bearer key", lambda s, l, v: (s, v if adapters else bad(v, "unauthenticated_adapter"))),
        ("session tools are exposed with validated problems", lambda s, l, v: (s, v if tools_ok else bad(v, "session_tools_missing"))),
    ]

    def _ready_ok(sessions, guard):
        for _, status, lease, _, needs in sessions:
            claimed = status == "active" and (lease == "fresh" or not guard)
            # A paused issue is never ready; a lapsed lease is not a live claim in DB time.
            if needs and guard:
                continue
            if claimed and guard:
                continue
            if not guard and (needs or claimed):
                return False
        return True

    init = (
        ((None, "none", "fresh", "", False), (None, "none", "fresh", "", False)),
        ("contribute", "contribute"),
        frozenset(),
    )

    def next_states(state):
        sessions, levels, violations = state
        result = []
        for idx, (label, action) in enumerate(actions):
            if idx == 10:  # downgrade action returns a 3-tuple of its own
                nsessions, nlevels, nviolations = action(sessions, levels, violations)
                result.append((label, (nsessions, nlevels, nviolations)))
                continue
            nsessions, nviolations = action(sessions, levels, violations)
            result.append((label, (nsessions, levels, nviolations)))
        return result

    def inv(state):
        if state[2]:
            reason = sorted(state[2])[0]
            return False, f"work-session invariant broken: {reason}"
        for owner, status, _, _, _ in state[0]:
            if status == "active" and owner is None:
                return False, "an active session has no owning agent"
        return True, ""

    return bfs_check(
        "M17",
        "Work Sessions and Claims (#36)",
        "At most one active session per issue; five-minute DB-time expiry releases only that claim and keeps progress; fenced agent writes and renewal need a live session held by the agent; a downgrade stops both; ready work omits claimed and Needs input issues",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/features/work-sessions/rest.ts",
            "apps/server/src/features/work-sessions/mcp.ts",
            "apps/server/src/features/work-sessions/index.ts",
            "apps/server/src/features/projects/service.ts",
            "apps/server/src/features/projects/rest.ts",
            "packages/contract/src/sessions.ts",
            "packages/contract/src/mcp-tools.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0022_spooky_barracuda.sql",
        ],
    )


def check_m18(facts: dict[str, Any]) -> CheckResult:
    """#40: resume is a read that distinguishes a live claim from an expired one without
    resurrecting it; progress survives interruption and is carried into reacquisition;
    reacquisition needs an expired claim of the same run and an available issue; stale
    renew/progress/write/completion never become a fresh claim; retries do not duplicate.
    Every transition consults a guard extracted from the live service/adapters/contract,
    so a deleted guard yields a shortest trace naming the exact operation."""
    read_only = facts["m18_resume_read_only"]
    resume_db_time = facts["m18_resume_db_time"]
    keeps_progress = facts["m18_resume_keeps_progress"]
    stale_rejected = facts["m18_stale_rejected"]
    db_time = facts["m18_db_time_liveness"]
    available = facts["m18_reacquire_available"]
    expired_only = facts["m18_reacquire_expired_only"]
    carry = facts["m18_reacquire_carries_progress"]
    fresh = facts["m18_reacquire_fresh_session"]
    idempotent = facts["m18_idempotent"]
    adapters = facts["m18_adapters"]
    problems = facts["m18_http_problems"]
    fence_guard = facts["m18_session_fence"]
    closed_guard = facts["m18_closed_refused"]
    update_db_time = facts["m18_update_db_time"]
    find_active_db_time = facts["m18_find_active_db_time"]

    KEYS = ("owner", "gen", "status", "lease", "progress")
    MAX_SESSIONS = 2

    def rows(sessions):
        return [dict(zip(KEYS, row)) for row in sessions]

    def pack(row_list):
        return tuple(tuple(row[k] for k in KEYS) for row in row_list)

    def materialize(row_list):
        """Lazy expiry in DB time: only lapsed active rows become expired."""
        if not db_time:
            return row_list
        return [
            dict(row, status="expired")
            if row["status"] == "active" and row["lease"] == "lapsed"
            else row
            for row in row_list
        ]

    def next_gen(row_list):
        return max([row["gen"] for row in row_list] or [0]) + 1

    def run_idx(sessions, owner):
        found = [i for i, row in enumerate(rows(sessions)) if row["owner"] == owner]
        return max(found) if found else None

    def claim(sessions, violations, owner):
        rs = materialize(rows(sessions))
        active = next((i for i, row in enumerate(rs) if row["status"] == "active"), None)
        if active is not None:
            if rs[active]["owner"] == owner:
                if not idempotent and len(rs) < MAX_SESSIONS:
                    rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                    return pack(rs), violations | {"duplicate_claim_on_retry"}
                return pack(rs), violations
            return pack(rs), violations  # issue_claimed: another worker holds it
        if len(rs) < MAX_SESSIONS:
            rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
        return pack(rs), violations

    def stale_write(sessions, violations, owner, action, fence=None):
        """renew, progress, completion and fenced writes all need a live held session.
        A `fence` names the session the delayed caller started with; it must still be the
        live session, otherwise the write is refused even if this agent holds a newer one."""
        rs = materialize(rows(sessions))
        idx = next(
            (i for i, row in enumerate(rs) if row["owner"] == owner and row["status"] == "active"),
            None,
        )
        if fence is not None:
            fenced = next((i for i, row in enumerate(rs) if row["gen"] == fence), None)
            valid = (
                fenced is not None
                and rs[fenced]["owner"] == owner
                and rs[fenced]["status"] == "active"
                and rs[fenced]["lease"] == "fresh"
            )
            if not valid:
                if not fence_guard and idx is not None:
                    # Buggy: the fence is ignored and the write falls through to S2.
                    violations = violations | {"stale_fence_bypassed"}
                else:
                    return pack(rs), violations
            else:
                idx = fenced
        if idx is None:
            if not stale_rejected and len(rs) < MAX_SESSIONS:
                rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                return pack(rs), violations | {f"stale_{action}_became_claim"}
            return pack(rs), violations
        if not db_time and rs[idx]["lease"] == "lapsed":
            violations = violations | {f"expired_claim_{action}_accepted"}
            if action == "renew":
                rs[idx]["lease"] = "fresh"
            return pack(rs), violations
        if action == "renew":
            rs[idx]["lease"] = "fresh"
        elif action == "progress":
            rs[idx]["progress"] = "p"
        elif action == "stop":
            rs[idx]["status"] = "ended"
        return pack(rs), violations

    def resume(sessions, violations, owner):
        rs = rows(sessions)
        idx = run_idx(pack(rs), owner)
        disposition = "none"
        if idx is not None:
            row = rs[idx]
            if row["status"] == "active" and row["lease"] == "fresh":
                disposition = "active"
            elif row["status"] == "active" and row["lease"] == "lapsed" and not resume_db_time:
                disposition = "active"  # buggy: a lapsed lease is reported as live
            elif (row["status"] == "active" and row["lease"] == "lapsed") or row["status"] == "expired":
                disposition = "expired"
            else:
                disposition = "ended"
        out = pack(rs)
        if idx is not None and not read_only:
            # A buggy resume re-arms the lease instead of just reporting it.
            rs[idx]["status"] = "active"
            rs[idx]["lease"] = "fresh"
            out = pack(rs)
            violations = violations | {"resume_resurrected_lease"}
        if idx is not None and not resume_db_time and row["lease"] == "lapsed":
            violations = violations | {"resume_missed_expiry"}
        if idx is not None and not keeps_progress:
            violations = violations | {"resume_dropped_progress"}
        return out, violations

    def reacquire(sessions, violations, owner, needs, closed):
        rs = materialize(rows(sessions))
        active = next((i for i, row in enumerate(rs) if row["status"] == "active"), None)
        if active is not None:
            if rs[active]["owner"] == owner:
                if not idempotent and len(rs) < MAX_SESSIONS:
                    rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                    return pack(rs), violations | {"duplicate_reacquire_claim"}
                return pack(rs), violations
            if not available:
                rs[active]["owner"] = owner
                return pack(rs), violations | {"reacquire_stole_live_claim"}
            return pack(rs), violations  # issue_claimed
        idx = run_idx(pack(rs), owner)
        prior = rs[idx] if idx is not None else None
        if prior is None or prior["status"] != "expired":
            if not expired_only and len(rs) < MAX_SESSIONS:
                rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=""))
                return pack(rs), violations | {"reacquire_without_expired_claim"}
            return pack(rs), violations
        if needs or closed:
            if (not available or (closed and not closed_guard)) and len(rs) < MAX_SESSIONS:
                rs.append(dict(owner=owner, gen=next_gen(rs), status="active", lease="fresh", progress=prior["progress"]))
                reason = "reacquire_closed_issue" if closed else "reacquire_while_paused"
                return pack(rs), violations | {reason}
            return pack(rs), violations  # issue_blocked
        if len(rs) >= MAX_SESSIONS:
            return pack(rs), violations
        gen = prior["gen"] if not fresh else next_gen(rs)
        progress = prior["progress"] if carry else ""
        violations = violations | (set() if carry else {"progress_lost_on_reacquire"})
        if gen == prior["gen"]:
            violations = violations | {"lease_resurrected"}
        rs.append(dict(owner=owner, gen=gen, status="active", lease="fresh", progress=progress))
        return pack(rs), violations

    def step(fn):
        """Adapt a (sessions, violations) -> (sessions, violations) step to full state."""
        def action(s, c, n, v):
            ns, nv = fn(s, v)
            return (ns, c, n, nv)
        return action

    def step_flags(fn):
        """Adapt a (sessions, violations, needs, closed) -> (sessions, violations) step."""
        def action(s, c, n, v):
            ns, nv = fn(s, v, n, c)
            return (ns, c, n, nv)
        return action

    actions = [
        ("the original run claims the issue", step(lambda s, v: claim(s, v, "R"))),
        ("another worker claims the issue", step(lambda s, v: claim(s, v, "S"))),
        ("five minutes pass in database time", lambda s, c, n, v: (pack([dict(row, lease="lapsed") if row["status"] == "active" else row for row in rows(s)]), c, n, v)),
        ("the original run resumes its conversation", step(lambda s, v: resume(s, v, "R"))),
        ("a stale renewal arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "renew"))),
        ("a stale progress report arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "progress"))),
        ("a stale completion arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "stop"))),
        ("a stale fenced issue write arrives on the expired session", step(lambda s, v: stale_write(s, v, "R", "edit"))),
        ("a delayed renewal fenced to session 1", step(lambda s, v: stale_write(s, v, "R", "renew", fence=1))),
        ("a delayed progress report fenced to session 1", step(lambda s, v: stale_write(s, v, "R", "progress", fence=1))),
        ("a delayed completion fenced to session 1", step(lambda s, v: stale_write(s, v, "R", "stop", fence=1))),
        ("the other worker renews its live claim", step(lambda s, v: stale_write(s, v, "S", "renew"))),
        ("the other worker completes its live claim", step(lambda s, v: stale_write(s, v, "S", "stop"))),
        ("the original run reacquires its expired claim", step_flags(lambda s, v, n, c: reacquire(s, v, "R", n, c))),
        ("the other worker reacquires its expired claim", step_flags(lambda s, v, n, c: reacquire(s, v, "S", n, c))),
        ("the issue is paused for input", lambda s, c, n, v: (s, c, True, v)),
        ("the input is answered", lambda s, c, n, v: (s, c, False, v)),
        ("the issue is closed", lambda s, c, n, v: (s, True, n, v)),
        ("the issue is reopened", lambda s, c, n, v: (s, False, n, v)),
        ("renew/progress/stop recheck DB-time liveness on UPDATE and findActive", lambda s, c, n, v: (s, c, n, v if update_db_time and find_active_db_time else v | {"lapsed_row_updated"})),
        ("resume/reacquire tools are exposed with validated problems", lambda s, c, n, v: (s, c, n, v if adapters and problems else v | {"tools_or_problems_missing"})),
    ]

    init = ((), False, False, frozenset())

    def inv(state):
        sessions, _, _, violations = state
        if violations:
            reason = sorted(violations)[0]
            return False, f"resume/reacquire invariant broken: {reason}"
        actives = [row for row in rows(sessions) if row["status"] == "active"]
        if len(actives) > 1:
            return False, "two active sessions hold the same issue"
        return True, ""

    return bfs_check(
        "M18",
        "Resume, Reacquisition and Stale Sessions (#40)",
        "Resume is a DB-time read that distinguishes live from expired claims without resurrecting them; progress survives interruption and reacquisition; a run reacquires only its own expired claim on an available issue; stale renew/progress/fenced writes/completions never become fresh claims; retries do not duplicate a claim",
        "safety",
        init,
        lambda state: [(label, action(*state)) for label, action in actions],
        inv,
        [
            "apps/server/src/features/work-sessions/service.ts",
            "apps/server/src/features/work-sessions/rest.ts",
            "apps/server/src/features/work-sessions/mcp.ts",
            "packages/contract/src/sessions.ts",
            "packages/contract/src/mcp-tools.ts",
        ],
    )


def check_m19(facts: dict[str, Any]) -> CheckResult:
    """#37: removal / voluntary leave revoke keys and grants and release active claims in
    one transaction, a renewal racing the departure cannot retain the claim, the last owner
    and a personal workspace cannot be left, re-invitation starts with fresh grants but the
    old key stays dead, and comments/attribution survive. Behavioral guards are explored by
    BFS; structural guards (lock order, no nested transaction, the thin REST leave route)
    are asserted from the extracted facts."""
    files = [
        "apps/server/src/features/workspaces/service.ts",
        "apps/server/src/features/workspaces/rest.ts",
        "apps/server/src/features/work-sessions/service.ts",
        "apps/server/src/features/agents/service.ts",
        "apps/server/src/features/projects/service.ts",
        "apps/server/src/features/index.ts",
        "apps/server/src/db/schema.ts",
        "db/migrations/0023_wealthy_silvermane.sql",
    ]
    structural = (
        "m19_issue_lock_order",
        "m19_no_nested_tx",
        "m19_active_only",
        "m19_release_status_guard",
        "m19_membership_lock",
        "m19_personal_scope",
        "m19_single_tx",
        "m19_leave_route",
    )
    missing = [name for name in structural if not facts[name]]
    if missing:
        return CheckResult(
            "M18",
            "Member Removal, Leave & Claim Release (#37)",
            "Departure revokes credentials and grants, releases claims, and a racing renewal cannot retain one",
            "safety",
            "violated",
            0,
            0,
            "M18 structural guard missing: " + ", ".join(missing),
            [f"remove the {name} guard from the #37 cleanup" for name in missing],
            files,
        )

    release_remove = facts["m19_release_in_remove"]
    release_leave = facts["m19_release_in_leave"]
    recheck = facts["m19_recheck_membership"]
    revoke_keys = facts["m19_revoke_keys"]
    revoke_grants = facts["m19_revoke_grants"]
    last_owner = facts["m19_last_owner_leave"]
    personal_guard = facts["m19_personal_not_leavable"]
    distinct = facts["m19_distinct_events"]
    keep_comments = facts["m19_attribution_kept"]

    def depart(state, event, guard):
        member, kind, is_owner, owners, key, grant, session, comments, events, inflight = state
        if revoke_keys:
            key = "revoked"
        if revoke_grants:
            grant = "revoked"
        if session == "active" and guard:
            session = "released"
        if not keep_comments:
            comments = 0
        if distinct:
            events = events | {event}
        return (False, kind, is_owner, owners, key, grant, session, comments, events, inflight)

    def removal(state):
        if not state[0] or state[1] != "shared":
            return state
        return depart(state, "member_removed", release_remove)

    def leave(state):
        member, kind, is_owner, owners, *_ = state
        if not member or kind != "shared":
            return state
        if is_owner and owners <= 1 and last_owner:
            return state
        next_state = depart(state, "owner_left" if is_owner else "member_left", release_leave)
        updated = list(next_state)
        updated[3] = owners - 1 if is_owner else owners
        return tuple(updated)

    def single_owner_context(state):
        # A shared workspace whose only owner is the caller: the last-owner safeguard is
        # the only thing between this and an unadministrable workspace.
        return (True, "shared", True, 1, "valid", "present", "active", 1, frozenset(), None)

    def personal_context(state):
        # A fresh personal-workspace scenario: one owner, no membership row and a live
        # agent claim. It starts its own history so the shared-workspace timeline above
        # cannot leak a "revived key" signal into this independent context.
        return (True, "personal", True, 1, "valid", "present", "active", 1, frozenset(), None)

    def leave_personal(state):
        if state[1] != "personal" or not state[0] or personal_guard:
            return state
        return depart(state, "owner_left", release_leave)

    def renew_start(state):
        if state[0] and state[6] == "active":
            updated = list(state)
            updated[9] = "renew"
            return tuple(updated)
        return state

    def renew_commit(state):
        if state[9] is None:
            return state
        updated = list(state)
        updated[9] = None
        if not state[0] and not recheck:
            # The in-flight renewal extends a claim whose human has already departed.
            updated[6] = "active"
        return tuple(updated)

    def reinvite(state):
        if state[0]:
            return state
        updated = list(state)
        updated[0] = True
        updated[2] = False
        updated[4] = "revoked" if revoke_keys else state[4]
        updated[5] = "fresh"
        updated[8] = state[8] | {"member_joined"}
        return tuple(updated)

    def add_comment(state):
        updated = list(state)
        updated[7] = min(2, state[7] + 1)
        return tuple(updated)

    actions = [
        ("an authorized owner removes the member", removal),
        ("the member leaves voluntarily", leave),
        ("a renewal starts before the departure", renew_start),
        ("the in-flight renewal commits after removal", renew_commit),
        ("the member is re-invited with fresh grants", reinvite),
        ("a comment keeps the issue's agent attribution", add_comment),
        ("context: a personal workspace with one owner and a live claim", personal_context),
        ("the personal owner tries to leave", leave_personal),
        ("context: a shared workspace with one owner and a live claim", single_owner_context),
        ("the last owner tries to leave the shared workspace", leave),
    ]
    init = (True, "shared", False, 2, "valid", "present", "active", 1, frozenset(), None)

    def next_states(state):
        return [(label, action(state)) for label, action in actions]

    def inv(state):
        member, kind, is_owner, owners, key, grant, session, comments, events, _ = state
        if kind == "shared" and owners < 1:
            return False, "shared workspace ended with no owner (last-owner guard missing)"
        if kind == "personal" and not member:
            return False, "personal workspace lost its owner (leave was allowed)"
        if not member:
            if key == "valid":
                return False, "removed member's agent key is still valid"
            if grant == "present":
                return False, "removed member still holds project access"
            if session == "active":
                return False, "removed member's agent retained an active claim"
            if not events:
                return False, "departure wrote no audit event"
        if "member_removed" in events and "member_joined" in events and key == "valid":
            return False, "pre-removal key revived on re-invitation"
        if comments < 1:
            return False, "departure erased the issue comment and its agent attribution"
        return True, ""

    return bfs_check(
        "M19",
        "Member Removal, Leave & Claim Release (#37)",
        "Removal/leave revoke keys and grants, release active claims in one transaction, block a racing renewal, protect the last owner and personal work, and keep audit and comments",
        "safety",
        init,
        next_states,
        inv,
        files,
    )


def check_m20(facts: dict[str, Any]) -> CheckResult:
    """#41: the three-resolution question lifecycle (open -> answered | paused |
    fallback_used, with paused -> answered). The fixed model is proven deadlock-free and
    exactly-once in database time; the same explorer run with the naive two-state timeout
    guards MUST deadlock a paused issue, which is the sensitivity proof for this model.

    State: (question status, issues.needs_input, claim, clock vs deadline, violations).
    Every transition below consults a guard extracted from the live service/contract.
    """
    guards = {
        "statuses": facts["m20_statuses"],
        "lock": facts["m20_issue_lock"],
        "db_time": facts["m20_db_time"],
        "once": facts["m20_exact_once"],
        "release": facts["m20_release_pause"],
        "unblock": facts["m20_paused_unblock"],
        "needs": facts["m20_needs_sync"],
        "no_nested": facts["m20_no_nested"],
        "human": facts["m20_human_only"],
        "email": facts["m20_email_after_commit"],
        "history": facts["m20_history"],
        "claim": facts["m20_claim_bounded"],
        "adapters": facts["m20_adapters"],
        "lock_order": facts["m20_lock_order"],
        "non_enumeration": facts["m20_non_enumeration"],
        "scoped_list": facts["m20_scoped_list"],
        "db_time_reads": facts["m20_db_time_reads"],
        "ask_scope": facts["m20_ask_scope"],
        "boundary_guard": facts["m20_boundary_guard"],
        "read_tool": facts["m20_read_tool"],
        "feature_seams": facts["m20_feature_seams"],
    }

    def explore(g: dict[str, bool], naive: bool) -> CheckResult:
        # The naive variant is the same explorer with every guard turned off: the 2-state
        # open -> answered | timed_out design from the literal reading of #20.
        g = {key: False for key in g} if naive else g
        init = ("open", True, "held", "before", frozenset())

        def transitions(state):
            status, needs, claim, clock, violations = state
            out: list[tuple[str, Any]] = []

            def go(label, nstatus, nneeds, nclaim, nclock, extra=frozenset()):
                out.append((label, (nstatus, nneeds, nclaim, nclock, violations | extra)))

            def bad(*reasons):
                return frozenset(reasons)

            if naive:
                # The literal 2-state reading of #20: open -> answered | timed_out, where a
                # post-deadline answer is follow-up only. This is the buggy variant whose
                # deadlock the fixed model must be shown to avoid.
                if clock == "before":
                    go("one-hour deadline passes in database time", status, needs, claim, "after")
                if claim == "held":
                    go("five-minute claim lapses without check-in", status, needs, "released", clock)
                if status == "open" and clock == "before":
                    go("human answers before the deadline", "answered", False, claim, clock)
                if status == "open" and clock == "after":
                    go("deadline marks the question timed_out (two-state model)", "timed_out", True, "released", clock)
                if status == "timed_out":
                    go("human answer after the deadline is stored only as a follow-up", status, needs, claim, clock)
                return out

            # Database time moves independently of any process: at/after the deadline an
            # answer is no longer "on time", even if no sweeper has run.
            if clock == "before":
                go("one-hour deadline passes in database time", status, needs, claim, "after")

            # A lapsed five-minute lease releases only the claim. It never erases the
            # question and never clears Needs input.
            if claim == "held":
                go("five-minute claim lapses without check-in", status, needs, "released", clock)

            # Check-in while waiting keeps the claim, bounded by the response deadline.
            if status == "open" and claim == "held" and clock == "before":
                go(
                    "waiting agent checks in and renews its claim",
                    status,
                    needs,
                    claim,
                    clock,
                    frozenset() if g["claim"] else bad("claim_not_bounded_by_deadline"),
                )
            if status == "open" and claim == "held" and clock == "after":
                if g["db_time"] and g["release"]:
                    go("check-in at the deadline pauses and releases the claim", "paused", True, "released", clock)
                else:
                    go("check-in renews past the deadline (bug)", status, needs, claim, clock, bad("renewed_past_deadline"))

            # Atomic deadline evaluation: open -> paused in DB time, release the claim, keep
            # Needs input; no fallback is authorized in #41.
            if status == "open" and clock == "after":
                if g["db_time"] and g["release"]:
                    go("deadline evaluation pauses, releases the claim, keeps Needs input", "paused", True, "released", clock)
                else:
                    go("deadline marks timed_out without pausing (bug)", "timed_out", True, "released", clock, bad("naive_two_state_timeout"))

            # Human answer before the deadline: the only on-time resolution.
            if status == "open" and clock == "before":
                if g["once"] and g["needs"]:
                    go("human answers before the deadline", "answered", False, claim, clock)
                else:
                    go("answer leaves Needs input set (bug)", "answered", True, claim, clock, bad("answer_left_needs_input"))

            # Human answer at/after the deadline. In the 3-resolution model an answer that
            # races the boundary first pauses, then unblocks; an answer to a paused question
            # transitions paused -> answered. In the naive model it is a follow-up only.
            if clock == "after":
                if status == "open":
                    if g["db_time"] and g["unblock"] and g["release"]:
                        go("answer races the deadline: pause then answered, Needs input cleared", "answered", False, claim, clock)
                    else:
                        go("late answer is follow-up only (bug)", "timed_out", True, claim, clock, bad("paused_issue_deadlock"))
                elif status == "paused":
                    if g["unblock"] and g["needs"]:
                        go("human answers a paused question; issue unblocked for reacquisition", "answered", False, "released", clock)
                    else:
                        go("answer to paused question stays follow-up only (bug)", status, needs, claim, clock, bad("paused_issue_deadlock"))
                elif status == "timed_out":
                    go("late answer to timed_out question stays follow-up only (bug)", status, needs, claim, clock, bad("paused_issue_deadlock"))
                elif status == "fallback_used":
                    go("late answer stored as follow-up without reversing fallback work", status, needs, claim, clock)
                elif status == "answered":
                    if g["once"]:
                        go("second answer is refused: one resolution", status, needs, claim, clock)
                    else:
                        go("second answer overwrites the resolution (bug)", status, needs, claim, clock, bad("two_resolutions"))

            # Strict actor gate: agent keys (including sibling runs), Readers and unrelated
            # members can never answer.
            go("sibling agent key tries to answer", status, needs, claim, clock,
               frozenset() if g["human"] else bad("agent_answered"))
            go("reader or unrelated member tries to answer", status, needs, claim, clock,
               frozenset() if g["human"] else bad("unauthorized_answered"))

            # Ready work and reacquisition must respect Needs input.
            if needs and not g["needs"]:
                go("ready-work listing offers a Needs input issue (bug)", status, needs, claim, clock, bad("needs_input_offered_as_ready"))
            else:
                go("ready-work listing omits Needs input issues", status, needs, claim, clock)
            if needs:
                go("agent tries to claim a Needs input issue", status, needs, claim, clock,
                   frozenset() if g["claim"] else bad("claimed_needs_input_issue"))
            elif claim == "released":
                go("agent reacquires the claim after the answer", status, needs, "held", clock)

            # Static source guards: their absence is itself a violation trace.
            if not g["statuses"]:
                go("schema uses a naive two-state resolution (bug)", status, needs, claim, clock, bad("no_paused_or_fallback_resolution"))
            if not g["lock"]:
                go("question write without an issue FOR UPDATE lock (bug)", status, needs, claim, clock, bad("unlocked_question_write"))
            if not g["no_nested"]:
                go("nested transaction while holding the issue row lock (bug)", status, needs, claim, clock, bad("nested_transaction"))
            if not g["email"]:
                go("owner email sent inside the DB lock (bug)", status, needs, claim, clock, bad("email_inside_lock"))
            if not g["history"]:
                go("question and resolution missing from history (bug)", status, needs, claim, clock, bad("question_not_in_history"))
            if not g["adapters"]:
                go("ask tool or REST validation missing (bug)", status, needs, claim, clock, bad("adapters_missing"))
            if not g["lock_order"]:
                go("deadline evaluation locks questions before the issue (bug)", status, needs, claim, clock, bad("lock_order_deadlock"))
            if not g["non_enumeration"]:
                go("unrelated caller learns a question exists via 403 (bug)", status, needs, claim, clock, bad("cross_workspace_existence_leak"))
            if not g["scoped_list"]:
                go("global LIMIT hides another workspace's inbox (bug)", status, needs, claim, clock, bad("inbox_cross_workspace_starvation"))
            if not g["db_time_reads"]:
                go("read reports open past the deadline (bug)", status, needs, claim, clock, bad("stale_open_on_read"))
            if not g["ask_scope"]:
                go("sibling run or closed issue asked a question (bug)", status, needs, claim, clock, bad("unscoped_ask"))
            if not g["boundary_guard"]:
                go("answer or follow-up lacks its DB-time guard (bug)", status, needs, claim, clock, bad("missing_boundary_guard"))
            if not g["read_tool"]:
                go("agent cannot read the answer back over MCP (bug)", status, needs, claim, clock, bad("no_mcp_read_tool"))
            if not g["feature_seams"]:
                go("work sessions bypasses the inbox public interface (bug)", status, needs, claim, clock, bad("seams_bypassed"))
            return out

        def invariant(state):
            status, needs, claim, clock, violations = state
            if naive and status == "timed_out":
                return False, "paused_issue_deadlock: a human answer at or after 1h is only a follow-up, so a paused issue stays Needs input forever"
            if violations:
                return False, "3-resolution question invariant broken: " + sorted(violations)[0]
            if status in ("open", "paused", "timed_out") and not needs:
                return False, "Needs input was lost while the question is unresolved"
            if status == "answered" and needs:
                return False, "an answered issue is still Needs input"
            if status == "paused" and claim == "held":
                return False, "a paused issue still holds the claim"
            return True, ""

        return bfs_check(
            "M18-naive" if naive else "M20",
            "Three-Resolution Question Lifecycle (#41)",
            "Naive two-state timeout deadlocks paused issues" if naive else
            "One DB-time resolution; a paused issue is unblocked by a human answer, keeps Needs input until then, and only humans may answer",
            "liveness" if naive else "safety",
            init,
            transitions,
            invariant,
            [
                "apps/server/src/features/inbox/service.ts",
                "apps/server/src/features/inbox/rest.ts",
                "apps/server/src/features/inbox/mcp.ts",
                "apps/server/src/features/work-sessions/service.ts",
                "apps/server/src/features/work-sessions/index.ts",
                "apps/server/src/features/index.ts",
                "packages/contract/src/questions.ts",
                "packages/contract/src/mcp-tools.ts",
                "apps/server/src/db/schema.ts",
                "db/migrations/0024_white_rage.sql",
            ],
        )

    fixed = explore(guards, False)
    naive = explore(guards, True)

    files = fixed.files
    if fixed.status != "verified":
        return fixed
    if naive.status != "violated":
        return CheckResult(
            "M20",
            "Three-Resolution Question Lifecycle (#41)",
            "Sensitivity: the naive 2-state model must deadlock a paused issue",
            "safety",
            "violated",
            fixed.states_explored,
            fixed.transitions_explored,
            "The buggy two-state variant was not detected; the model is not sensitive.",
            [],
            files,
        )
    return CheckResult(
        "M20",
        "Three-Resolution Question Lifecycle (#41)",
        "One DB-time resolution; a paused issue is unblocked by a human answer, keeps Needs input until then, and only humans may answer",
        "safety",
        "verified",
        fixed.states_explored + naive.states_explored,
        fixed.transitions_explored + naive.transitions_explored,
        f"Verified across {fixed.states_explored} reachable states ({fixed.transitions_explored} transitions); "
        f"sensitivity: the naive 2-state variant is violated at '{naive.summary.split(': ')[-1]}' "
        f"with trace: {' -> '.join(naive.counterexample[:4])}.",
        [],
        files,
    )


def check_m21(facts: dict[str, Any]) -> CheckResult:
    """#39: a personal-to-shared transfer is atomic, rechecks both authorities and the
    project's current ownership, blocks live work in database time, and leaves no source
    key, source grant or pending offer behind. Destination membership gates every reveal
    of a destination's name and owners: the source owner's authorization carries no PII
    for a stranger, and a separate Create-projects receiver can preview the pending token
    before accepting. Each transition consults a source-extracted guard; flipping one
    produces a shortest counterexample naming the exact broken operation."""
    g = facts

    def bad(violations: frozenset[str], reason: str) -> frozenset[str]:
        return violations | {reason}

    def apply_transfer(state, violations):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        v = violations

        # One transaction, ownership lock first, workspace guards before the project row
        # and issues, all on the same transaction.
        if not g["m21_single_tx"]:
            v = bad(v, "accept_split_across_transactions")
        if not g["m21_lock_first"]:
            v = bad(v, "ownership_lock_not_first")
        if not g["m21_guard_order"]:
            v = bad(v, "workspace_guards_not_ordered_before_project")
        if not g["m21_issue_lock"]:
            v = bad(v, "issues_not_locked_before_active_work_check")
        if not g["m21_preserve_identity"]:
            v = bad(v, "authorship_rewritten_on_move")

        # Cleanup: source grants, source keys' project scope and only still-pending offers.
        if not g["m21_grant_cleanup"]:
            v = bad(v, "source_grant_survived")
        else:
            grants = grants - {"old"}
        if not g["m21_key_cleanup"]:
            v = bad(v, "source_key_followed_project")
        else:
            keys = False
        if not g["m21_offer_cleanup"] or not g["m21_pending_offers_only"]:
            v = bad(v, "pending_offer_not_invalidated")
        else:
            offers = False
        if not g["m21_expire_lapsed"]:
            v = bad(v, "stale_active_session_moved")
        if not g["m21_revoke_siblings"]:
            v = bad(v, "sibling_authorization_left_pending")

        # Rebuild access and the destination's own audit trail; source events stay source.
        if not g["m21_grant_rebuild"]:
            v = bad(v, "destination_manage_grants_missing")
        else:
            grants = grants | {"dest"}
        if not g["m21_grant_events"]:
            v = bad(v, "destination_grant_events_missing")
        if not g["m21_receipt_events"]:
            v = bad(v, "destination_receipt_missing")
        if not g["m21_source_events_scoped"]:
            v = bad(v, "source_access_history_leaked_to_destination")
        events = events | {"dest_grants", "receipt", "source_out"}

        return ("transferred", "accepted", dest_ok, dest_member, source_ok, "dest",
                "none", keys, grants, events, offers, auth_live, v)

    def preview(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if not g["m21_preview"]:
            v = bad(v, "no_preview_before_confirmation")
        if not g["m21_http_problems"]:
            v = bad(v, "validated_route_without_400_problem")
        if not g["m21_human_only"]:
            v = bad(v, "agent_key_can_authorize_transfer")
        if not dest_member and not g["m21_dest_membership_preview"]:
            v = bad(v, "destination_enumerated_by_preview")
        return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def lose_source(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, False, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def join_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, False, True, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def leave_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, False, False, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def gain_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, True, True, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def lose_dest(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, False, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def authorize(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "start":
            return state
        if not source_ok:
            if not g["m21_source_owner"]:
                v = bad(v, "authorized_without_source_ownership")
            else:
                return state  # correctly refused
        if not dest_ok and not g["m21_two_party"]:
            v = bad(v, "two_party_authorization_required_destination_authority")
        if not g["m21_authorization_persisted"]:
            v = bad(v, "authorization_not_persisted")
        if not dest_member and not g["m21_authorize_redaction"]:
            v = bad(v, "destination_owner_pii_leaked")
        return ("authorized", "pending", dest_ok, dest_member, source_ok, pws,
                claim, keys, grants, events, offers, True, v)

    def receiver_preview(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "authorized" or auth != "pending":
            return state
        if not g["m21_receiver_preview"]:
            v = bad(v, "no_receiver_preview")
        if not dest_member or not dest_ok:
            if not g["m21_receiver_authority"]:
                v = bad(v, "unauthorized_receiver_saw_preview")
        elif not g["m21_receiver_recipient"]:
            v = bad(v, "receiver_not_listed_for_acceptor")
        return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, auth_live, v)

    def claim(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, pws, "live", keys,
                grants, events, offers, auth_live, v)

    def expire_claim(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, pws, "expired", keys,
                grants, events, offers, auth_live, v)

    def expire_auth(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                grants, events, offers, False, v)

    def move_project(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        return (phase, auth, dest_ok, dest_member, source_ok, "elsewhere", claim,
                keys, grants, events, offers, auth_live, v)

    def accept(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "authorized" or auth != "pending":
            return state
        if not g["m21_authorization_persisted"]:
            v = bad(v, "accept_without_persisted_authorization")
        if not auth_live:
            if not g["m21_db_time_expiry"]:
                return apply_transfer(state, bad(v, "expired_authorization_accepted"))
            return state
        if not dest_member:
            if not g["m21_accept_membership"]:
                return apply_transfer(state, bad(v, "non_member_accepted_transfer"))
            return state
        if not source_ok:
            if not g["m21_recheck_source"]:
                return apply_transfer(state, bad(v, "accepted_after_source_lost"))
            return state
        if not dest_ok:
            if not g["m21_recheck_authority"]:
                return apply_transfer(state, bad(v, "accepted_after_destination_authority_lost"))
            return state
        if dest_ok and not g["m21_dest_authority"]:
            v = bad(v, "valid_destination_authority_refused")
        if pws != "source":
            if not g["m21_recheck_workspace"]:
                return apply_transfer(state, bad(v, "accepted_after_workspace_changed"))
            return state
        if claim == "live":
            if not (g["m21_active_work"] and g["m21_db_time_live"]):
                return apply_transfer(state, bad(v, "transferred_with_live_work"))
            return state
        if claim == "expired" and not g["m21_db_time_live"]:
            v = bad(v, "expired_claim_blocked_transfer")
        return apply_transfer(state, v)

    def complete(state):
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, v) = state
        if phase != "start" or not source_ok:
            return state
        if not dest_member:
            if not g["m21_dest_membership_complete"]:
                v = bad(v, "complete_enumerated_destination")
            return (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys,
                    grants, events, offers, auth_live, v)
        if not dest_ok:
            return state
        if not g["m21_dest_authority"]:
            v = bad(v, "direct_flow_denied_valid_authority")
        if pws != "source":
            return state
        if claim == "live" and not (g["m21_active_work"] and g["m21_db_time_live"]):
            return apply_transfer(state, bad(v, "transferred_with_live_work"))
        if claim == "live":
            return state
        return apply_transfer(state, v)

    actions = [
        ("the personal owner previews the destination, access changes and live work", preview),
        ("a stranger or non-authority member previews the pending token", receiver_preview),
        ("the authorizing owner loses the source workspace", lose_source),
        ("the receiver joins the destination without Create projects", join_dest),
        ("a member leaves the destination", leave_dest),
        ("the destination grants Create projects to the receiver", gain_dest),
        ("destination Create projects authority is withdrawn", lose_dest),
        ("the source owner authorizes without destination authority", authorize),
        ("a worker claims an issue on the project", claim),
        ("the claim's lease lapses in database time", expire_claim),
        ("the authorization expires in database time", expire_auth),
        ("the project moves to another workspace before acceptance", move_project),
        ("the destination owner or Create projects member accepts", accept),
        ("one person with both authorities completes directly", complete),
    ]

    init = ("start", "none", False, False, True, "source", "none", True,
            frozenset({"old"}), frozenset(), True, True, frozenset())

    def next_states(state):
        return [(label, action(state)) for label, action in actions]

    def inv(state):
        v = state[-1]
        if v:
            return False, f"project-transfer invariant broken: {sorted(v)[0]}"
        (phase, auth, dest_ok, dest_member, source_ok, pws, claim, keys, grants,
         events, offers, auth_live, _) = state
        if phase == "transferred":
            if keys:
                return False, "a source key still names the moved project"
            if "old" in grants:
                return False, "a source grant survived the move"
            if "dest" not in grants:
                return False, "destination Manage grants were not rebuilt"
            if "receipt" not in events or "dest_grants" not in events:
                return False, "destination recorded no receipt and grant events"
            if offers:
                return False, "a pending offer still names the moved project"
        if phase == "authorized" and auth != "pending":
            return False, "an authorization left pending is not pending"
        return True, ""

    return bfs_check(
        "M21",
        "Personal-to-Shared Project Transfer (#39)",
        "Destination membership gates every reveal of its name and owners, including a redacted source-owner authorization and a receiver-only preview; acceptance is one transaction that rechecks both authorities, current ownership and no live DB-time work, expires lapsed leases, keeps settled offers, revokes rival tokens, rebuilds destination Manage and receipts, and removes source keys, grants and pending offers",
        "safety",
        init,
        next_states,
        inv,
        [
            "apps/server/src/features/transfers/service.ts",
            "apps/server/src/features/transfers/rest.ts",
            "apps/server/src/features/transfers/index.ts",
            "packages/contract/src/transfers.ts",
            "apps/server/src/db/schema.ts",
            "db/migrations/0025_thick_valeria_richards.sql",
        ],
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
        check_m11(facts),
        check_m12(facts),
        check_m13(facts),
        check_m14(facts),
        check_m15(facts),
        check_m16(facts),
        check_m17(facts),
        check_m18(facts),
        check_m19(facts),
        check_m20(facts),
        check_m21(facts),
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
