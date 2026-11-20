#!/usr/bin/env python3
"""
Orrery Formal Verification Model Checker (M1-M13).

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
        "revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actor.humanId)" in remove_member_fn
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

    # M16 (#36): work sessions, claims and five-minute leases. Every guard is read from
    # the service, the fenced projects write, the schema/migration and the adapters, so
    # removing a row lock, the unique index, the lazy expiry or the session gate flips the
    # model to a shortest counterexample naming the exact TS function.
    sess_src = read_text("apps/server/src/features/work-sessions/service.ts")
    sess_rest_src = read_text("apps/server/src/features/work-sessions/rest.ts")
    sess_mcp_src = read_text("apps/server/src/features/work-sessions/mcp.ts")
    sess_index_src = read_text("apps/server/src/features/work-sessions/index.ts")
    mig_0021 = read_text("db/migrations/0021_wild_scarlet_witch.sql")
    lock_issue_fn = slice_between(sess_src, "async function lockIssue(", "// Lazy expiry")
    expire_fn = slice_between(sess_src, "async function expireStale(", "const fiveMinutes")
    claim_fn = slice_between(sess_src, "async claim(actor, input)", "async renew(actor, issueId)")
    renew_fn = slice_between(sess_src, "async renew(actor, issueId)", "async progress(actor, issueId, summary)")
    ready_fn = slice_between(sess_src, "async readyWork(actorArg, projectId)", "async agentHoldsSession(")
    gate_fn = slice_between(sess_src, "async agentHoldsSession(", "};\n}")
    update_issue_fn = slice_between(proj_src, "async updateIssue(actorArg, issueId, input)", "async listComments(")
    work_sessions_table = slice_between(schema_src, "export const workSessions = pgTable(", "// A basic Markdown knowledge entry")

    m16_unique_index = (
        "one_active_work_session_per_issue" in mig_0021
        and "one_active_work_session_per_issue" in work_sessions_table
    )
    m16_issue_lock = (
        '.for("update")' in lock_issue_fn
        and "lockIssue(tx" in claim_fn
        and "lockIssue(tx" in renew_fn
        and '.for("update")' in update_issue_fn
    )
    m16_lazy_expiry = (
        "lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in expire_fn
        and "status: WorkSessionStatus.enum.expired" in expire_fn
        and "expireStale(tx" in claim_fn
        and "expireStale(tx" in renew_fn
    )
    m16_db_time_lease = "statement_timestamp() + interval '5 minutes'" in sess_src
    m16_progress_independent = (
        '"progress"' in work_sessions_table
        and "progress:" not in expire_fn
        and "progressUpdatedAt:" not in expire_fn
    )
    m16_fenced_write = (
        "sessionGate(tx, actor.identity.agentId" in update_issue_fn
        and 'throw new ProjectsError("session_required")' in update_issue_fn
        and "agentHoldsSession:" in sess_index_src
    )
    m16_gate_no_claim = (
        ".insert(workSessions)" not in gate_fn
        and "expireCommitted(issueId)" in gate_fn
        and "claim(" not in gate_fn
    )
    m16_renew_active = (
        "eq(workSessions.status, WorkSessionStatus.enum.active)" in renew_fn
        and 'throw new SessionsError("session_required")' in renew_fn
    )
    m16_recheck_access = (
        "requireAccess(" in renew_fn
        and "projectAccessCeiling" in sess_src
        and '"insufficient_access"' in sess_src
    )
    m16_session_identity = (
        "agentId: identity.agentId" in claim_fn
        and "runId: input.runId" in claim_fn
        and "workspaceId: identity.workspaceId" in claim_fn
        and "keyId" not in claim_fn
    )
    m16_helper_shares = (
        "return toSession(existing)" in claim_fn
        and "existing.runId === input.runId" in claim_fn
    )
    m16_ready_db_time = (
        "gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`)" in ready_fn
        and "eq(issues.needsInput, false)" in ready_fn
        and "isNull(workSessions.id)" in ready_fn
    )
    m16_unfenced = (
        "sessionGate(tx" in update_issue_fn
        and proj_src.count("sessionGate(") == 1
    )
    m16_adapters = (
        "await authenticate(request)" in sess_mcp_src
        and "isAgentError(error)" in sess_rest_src
        and "SessionsError" in sess_rest_src
    )
    m16_tools = all(
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
    m16_problems = sess_rest_src.count("400: problem(") >= 5

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
        "m16_unique_index": m16_unique_index,
        "m16_issue_lock": m16_issue_lock,
        "m16_lazy_expiry": m16_lazy_expiry,
        "m16_db_time_lease": m16_db_time_lease,
        "m16_progress_independent": m16_progress_independent,
        "m16_fenced_write": m16_fenced_write,
        "m16_gate_no_claim": m16_gate_no_claim,
        "m16_renew_active": m16_renew_active,
        "m16_recheck_access": m16_recheck_access,
        "m16_session_identity": m16_session_identity,
        "m16_helper_shares": m16_helper_shares,
        "m16_ready_db_time": m16_ready_db_time,
        "m16_unfenced": m16_unfenced,
        "m16_adapters": m16_adapters,
        "m16_tools": m16_tools,
        "m16_problems": m16_problems,
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


def check_m16(facts: dict[str, Any]) -> CheckResult:
    """#36: one active claim per issue, DB-time five-minute expiry, progress kept, and
    fenced agent writes. Two agents (A, B) and two issues keep the state space small;
    every transition consults a guard extracted from the live service, projects fence and
    schema, so a deleted guard produces a shortest trace naming the exact operation."""
    unique = facts["m16_unique_index"]
    lock = facts["m16_issue_lock"]
    lazy = facts["m16_lazy_expiry"]
    db_time = facts["m16_db_time_lease"]
    keep_progress = facts["m16_progress_independent"]
    fenced = facts["m16_fenced_write"]
    no_claim = facts["m16_gate_no_claim"]
    renew_active = facts["m16_renew_active"]
    recheck = facts["m16_recheck_access"]
    identity = facts["m16_session_identity"]
    shared = facts["m16_helper_shares"]
    ready_db = facts["m16_ready_db_time"]
    unfenced = facts["m16_unfenced"]
    adapters = facts["m16_adapters"]
    tools_ok = facts["m16_tools"] and facts["m16_problems"]

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
        "M16",
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
            "db/migrations/0021_wild_scarlet_witch.sql",
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
