import { randomUUID } from "node:crypto";
import {
  AgentKeyEventType,
  ProjectAccessEventType,
  ProjectAccessLevel,
  WorkSessionStatus,
  WorkspaceKind,
  type AccountStatus,
} from "@orrery/contract";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  accountRecoveryEvents,
  agentApiKeys,
  agentKeyEvents,
  agents,
  browserSessions,
  humans,
  issues,
  projectAccessEvents,
  projectAccessGrants,
  projects,
  workSessions,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";

// Account deactivation (#38). The service is the only file that decides anything: it
// enforces the administrator gate, the last-administrator guard, and the whole cleanup in
// one transaction. Nothing here deletes a human, a membership, or their authored work.
// Reactivation clears only the account's deactivated mark — shared authority and revoked
// credentials are never restored automatically.

export type DeactivationErrorKind =
  | "not_signed_in"
  | "not_system_administrator"
  | "account_not_found"
  | "last_admin"
  | "already_deactivated"
  | "already_active";

const messages: Record<DeactivationErrorKind, string> = {
  not_signed_in: "Not signed in.",
  not_system_administrator: "Only a system administrator can change account status.",
  account_not_found: "No account has that id.",
  last_admin: "The last active system administrator cannot be deactivated.",
  already_deactivated: "This account is already deactivated.",
  already_active: "This account is not deactivated.",
};

export class DeactivationError extends Error {
  readonly kind: DeactivationErrorKind;

  constructor(kind: DeactivationErrorKind) {
    super(messages[kind]);
    this.name = "DeactivationError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new DeactivationError("not_signed_in");
  return account;
}

// The acting administrator is rechecked inside the transaction: a session can be read
// before another administrator deactivates it, and only an *active* administrator may
// deactivate or reactivate anyone (ADR-0001's bootstrap role, #38's last-admin rule).
async function requireActiveAdministrator(tx: DbTransaction, humanId: string) {
  const [admin] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(
      and(
        eq(humans.id, humanId),
        eq(humans.isSystemAdministrator, true),
        isNull(humans.deactivatedAt),
      ),
    )
    .limit(1);
  if (admin === undefined) throw new DeactivationError("not_system_administrator");
}

async function accountById(tx: DbTransaction, humanId: string) {
  const [row] = await tx
    .select({
      id: humans.id,
      email: humans.email,
      isSystemAdministrator: humans.isSystemAdministrator,
      deactivatedAt: humans.deactivatedAt,
    })
    .from(humans)
    .where(eq(humans.id, humanId))
    .limit(1)
    // FOR UPDATE conflicts with the key-share lock claims take on the account before any
    // issue lock, so a racing claim cannot slip past the deactivation and its release pass.
    .for("update");
  if (row === undefined) throw new DeactivationError("account_not_found");
  return row;
}

// The same transaction-wide ownership lock every workspace ownership writer takes, first.
// The membership suspension below fires the per-workspace guard triggers, so deactivation
// must serialize with removals, appointments and invitations exactly like they do.
async function lockOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

// Advance each affected workspace's guard in ascending id order, before touching any
// membership, so a REPEATABLE READ writer with a stale snapshot fails instead of committing
// an ownerless workspace. The BEFORE triggers advance these rows too; doing it here makes
// the serialization point explicit and ordered across all workspaces at once.
async function bumpGuards(tx: DbTransaction, workspaceIds: readonly string[]) {
  for (const workspaceId of workspaceIds) {
    await tx
      .insert(workspaceOwnershipGuards)
      .values({ workspaceId, version: 0 })
      .onConflictDoUpdate({
        target: workspaceOwnershipGuards.workspaceId,
        set: { version: sql`${workspaceOwnershipGuards.version} + 1` },
      });
  }
}

async function recordAccountEvent(
  tx: DbTransaction,
  input: {
    humanId: string;
    actorHumanId: string;
    type: "account_deactivated" | "account_reactivated";
  },
) {
  await tx.insert(accountRecoveryEvents).values({
    id: randomUUID(),
    humanId: input.humanId,
    actorHumanId: input.actorHumanId,
    type: input.type,
    createdAt: sql`statement_timestamp()`,
  });
}

export interface DeactivationDeps {
  db: PostgresJsDatabase;
}

export interface DeactivationService {
  deactivate(account: SessionAccount | null, humanId: string): Promise<AccountStatus>;
  reactivate(account: SessionAccount | null, humanId: string): Promise<AccountStatus>;
}

export function createDeactivationService({ db }: DeactivationDeps): DeactivationService {
  return {
    async deactivate(account, humanId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        await requireActiveAdministrator(tx, actor.humanId);
        const target = await accountById(tx, humanId);
        if (target.deactivatedAt !== null) throw new DeactivationError("already_deactivated");

        // The last active system administrator cannot be deactivated. A deactivated
        // administrator is already outside the count, so the guard applies only to an
        // active one; two active administrators may deactivate each other in sequence.
        if (target.isSystemAdministrator) {
          const [activeAdmins] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(humans)
            .where(and(eq(humans.isSystemAdministrator, true), isNull(humans.deactivatedAt)));
          if ((activeAdmins?.count ?? 0) <= 1) throw new DeactivationError("last_admin");
        }

        // Every affected shared workspace, in one deterministic order for the guard
        // updates. A suspended membership is already out of scope: there is nothing left
        // to revoke or suspend for it.
        const shared = await tx
          .select({ workspaceId: workspaceMemberships.workspaceId })
          .from(workspaceMemberships)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
          .where(
            and(
              eq(workspaceMemberships.humanId, humanId),
              eq(workspaces.kind, WorkspaceKind.enum.shared),
              isNull(workspaceMemberships.suspendedAt),
            ),
          );
        const workspaceIds = shared.map((row) => row.workspaceId).toSorted();
        await bumpGuards(tx, workspaceIds);

        // 1. The account itself. Browser sessions and keys are stopped below; the row and
        // everything attributed to it are preserved.
        await tx
          .update(humans)
          .set({ deactivatedAt: sql`statement_timestamp()` })
          .where(eq(humans.id, humanId));

        // 2. Stop every browser session for this human. A retained cookie already stops
        // resolving in the session reader, but deleting the rows ends them outright.
        await tx.delete(browserSessions).where(eq(browserSessions.humanId, humanId));

        // 3. Revoke every unrevoked key held by this human's agents, across ALL workspaces
        // (personal ones too). One secret-free audit event per newly revoked key, with the
        // administrator as actor — the same shape as any other revocation.
        const ownedAgents = tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.humanId, humanId));
        const revokedKeys = await tx
          .update(agentApiKeys)
          .set({
            revokedAt: sql`statement_timestamp()`,
            revokedByHumanId: actor.humanId,
          })
          .where(and(isNull(agentApiKeys.revokedAt), inArray(agentApiKeys.agentId, ownedAgents)))
          .returning({
            id: agentApiKeys.id,
            agentId: agentApiKeys.agentId,
            workspaceId: agentApiKeys.workspaceId,
          });
        for (const key of revokedKeys) {
          await tx.insert(agentKeyEvents).values({
            id: randomUUID(),
            keyId: key.id,
            agentId: key.agentId,
            workspaceId: key.workspaceId,
            type: AgentKeyEventType.enum.agent_key_revoked,
            actorHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
          });
        }

        // 4. Revoke every project access grant for this human across shared workspaces,
        // with the same attributed, level-aware event a manager's revocation writes.
        const grants = await tx
          .select({
            id: projectAccessGrants.id,
            projectId: projectAccessGrants.projectId,
            workspaceId: projects.workspaceId,
            level: projectAccessGrants.level,
          })
          .from(projectAccessGrants)
          .innerJoin(projects, eq(projects.id, projectAccessGrants.projectId))
          .where(eq(projectAccessGrants.humanId, humanId));
        if (grants.length > 0) {
          await tx.delete(projectAccessGrants).where(
            inArray(
              projectAccessGrants.id,
              grants.map((grant) => grant.id),
            ),
          );
          for (const grant of grants) {
            await tx.insert(projectAccessEvents).values({
              id: randomUUID(),
              projectId: grant.projectId,
              workspaceId: grant.workspaceId,
              actorHumanId: actor.humanId,
              subjectHumanId: humanId,
              type: ProjectAccessEventType.enum.project_access_revoked,
              level: null,
              previousLevel: ProjectAccessLevel.parse(grant.level),
              createdAt: sql`statement_timestamp()`,
            });
          }
        }

        // 5. Suspend each shared membership in place: keep the row and its history,
        // remember the ownership it held, and strip every current authority. The deferred
        // owner trigger accepts a workspace with no active owner only because a suspended
        // is_former_owner row remains (#38 -> #43). Personal workspaces never appear here.
        const sharedWorkspaceIds = tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.kind, WorkspaceKind.enum.shared));
        // An explicit FOR UPDATE is required, not the implicit NO KEY UPDATE of the UPDATE
        // below: the claim path holds FOR KEY SHARE on this membership while it locks an
        // issue, and only FOR UPDATE conflicts with that lock. Taking it here, before the
        // issue locks, gives every writer the same membership -> issue lock order.
        await tx
          .select({ id: workspaceMemberships.id })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
              inArray(workspaceMemberships.workspaceId, sharedWorkspaceIds),
            ),
          )
          .orderBy(workspaceMemberships.id)
          .for("update");
        await tx
          .update(workspaceMemberships)
          .set({
            suspendedAt: sql`statement_timestamp()`,
            isFormerOwner: sql`${workspaceMemberships.isOwner}`,
            isOwner: false,
            canCreateProjects: false,
            canInviteMembers: false,
            canRemoveMembers: false,
            canManageMemberPermissions: false,
          })
          .where(
            and(
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
              inArray(workspaceMemberships.workspaceId, sharedWorkspaceIds),
            ),
          );

        // 6. Release every active claim held by the human's agents across ALL workspaces.
        // This runs AFTER the membership suspension above on purpose: claims and renewals
        // lock the human's membership FOR KEY SHARE before they lock an issue FOR UPDATE,
        // so deactivation must take the same two locks in the same order. Suspending the
        // membership first makes a racing claim either wait and then see a suspended
        // membership, or commit before the suspension and be visible to this release pass.
        // Affected issues are locked in id order before the sessions are ended; a claim
        // that legitimately completed after the read is left alone by the status guard.
        const claims = await tx
          .select({ id: workSessions.id, issueId: workSessions.issueId })
          .from(workSessions)
          .where(
            and(
              eq(workSessions.status, WorkSessionStatus.enum.active),
              inArray(workSessions.agentId, ownedAgents),
            ),
          );
        if (claims.length > 0) {
          const issueIds = [...new Set(claims.map((claim) => claim.issueId))].toSorted();
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(inArray(issues.id, issueIds))
            .orderBy(issues.id)
            .for("update");
          await tx
            .update(workSessions)
            .set({
              status: WorkSessionStatus.enum.released,
              endedAt: sql`statement_timestamp()`,
              updatedAt: sql`statement_timestamp()`,
            })
            .where(
              and(
                eq(workSessions.status, WorkSessionStatus.enum.active),
                inArray(
                  workSessions.id,
                  claims.map((claim) => claim.id),
                ),
              ),
            );
          // #94: a released claim is work ending without completion. Under the same
          // issue locks, return any in_progress issue to the ready queue; the guard
          // leaves work that completed in the meantime untouched.
          await tx
            .update(issues)
            .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
            .where(and(inArray(issues.id, issueIds), eq(issues.status, "in_progress")));
        }

        // 7. One secret-free event so administrators can inspect the change in history.
        await recordAccountEvent(tx, {
          humanId,
          actorHumanId: actor.humanId,
          type: "account_deactivated",
        });

        const [updated] = await tx
          .select({ deactivatedAt: humans.deactivatedAt })
          .from(humans)
          .where(eq(humans.id, humanId))
          .limit(1);
        return {
          humanId,
          email: target.email,
          deactivatedAt: updated?.deactivatedAt?.toISOString() ?? null,
          isSystemAdministrator: target.isSystemAdministrator,
        };
      });
    },

    async reactivate(account, humanId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireActiveAdministrator(tx, actor.humanId);
        const target = await accountById(tx, humanId);
        if (target.deactivatedAt === null) throw new DeactivationError("already_active");

        // Only the identity is restored. Memberships stay suspended (with is_former_owner
        // preserved), grants stay revoked, and keys stay revoked: a reactivated human signs
        // in again and their personal work returns, but shared authority returns only
        // through a fresh invitation, and credentials only through replacement keys (#38).
        await tx.update(humans).set({ deactivatedAt: null }).where(eq(humans.id, humanId));
        await recordAccountEvent(tx, {
          humanId,
          actorHumanId: actor.humanId,
          type: "account_reactivated",
        });
        return {
          humanId,
          email: target.email,
          deactivatedAt: null,
          isSystemAdministrator: target.isSystemAdministrator,
        };
      });
    },
  };
}
