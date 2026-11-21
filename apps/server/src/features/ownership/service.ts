import { randomUUID } from "node:crypto";
import {
  WorkspaceKind,
  type InstallationWorkspace,
  type InstallationWorkspaceMember,
  type OwnershipRecovery,
} from "@orrery/contract";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  accountRecoveryEvents,
  humans,
  workspaceEvents,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import type { SessionAccount } from "../accounts/index.ts";
import type { OutgoingMail } from "../settings/index.ts";

export type OwnershipErrorKind =
  | "not_signed_in"
  | "not_system_administrator"
  | "workspace_not_found"
  | "human_not_found"
  | "member_not_found"
  | "self_recovery_forbidden"
  | "workspace_has_active_owner"
  | "target_deactivated"
  | "recipient_ineligible";

const messages: Record<OwnershipErrorKind, string> = {
  not_signed_in: "Not signed in.",
  not_system_administrator: "Only an active system administrator can do that.",
  workspace_not_found: "This shared workspace does not exist.",
  human_not_found: "No account has that id.",
  member_not_found: "That person is not a member of this workspace.",
  self_recovery_forbidden: "The acting administrator cannot be the recovered owner.",
  workspace_has_active_owner: "This workspace still has an active owner.",
  target_deactivated: "The recipient's account is deactivated and must be reactivated first.",
  recipient_ineligible: "The recipient is not an eligible member or former owner.",
};

export class OwnershipError extends Error {
  readonly kind: OwnershipErrorKind;

  constructor(kind: OwnershipErrorKind) {
    super(messages[kind]);
    this.name = "OwnershipError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new OwnershipError("not_signed_in");
  return account;
}

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
  if (admin === undefined) throw new OwnershipError("not_system_administrator");
}

async function lockOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function bumpGuard(tx: DbTransaction, workspaceId: string) {
  await tx
    .insert(workspaceOwnershipGuards)
    .values({ workspaceId, version: 0 })
    .onConflictDoUpdate({
      target: workspaceOwnershipGuards.workspaceId,
      set: { version: sql`${workspaceOwnershipGuards.version} + 1` },
    });
}

export interface OwnershipDeps {
  db: PostgresJsDatabase;

  deliver: (mail: OutgoingMail) => Promise<void>;
  log?: Logger;
}

export interface OwnershipService {
  directory(account: SessionAccount | null): Promise<InstallationWorkspace[]>;
  recoverOwnership(
    account: SessionAccount | null,
    workspaceId: string,
    targetHumanId: string,
  ): Promise<OwnershipRecovery>;
}

async function notifyMembers(
  db: PostgresJsDatabase,
  deliver: (mail: OutgoingMail) => Promise<void>,
  log: Logger | undefined,
  input: { workspaceId: string; workspaceName: string; promotedEmail: string },
) {
  let recipients: string[];
  try {
    const rows = await db
      .select({ email: humans.email })
      .from(workspaceMemberships)
      .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          isNull(workspaceMemberships.suspendedAt),
          isNull(humans.deactivatedAt),
        ),
      );
    recipients = [...new Set([...rows.map((row) => row.email), input.promotedEmail])];
  } catch (error) {
    log?.warn("ownership recovery recipient lookup failed", errorNameAndCode(error));
    return;
  }
  const subject = "Workspace ownership recovered";
  const text = [
    `Ownership of the workspace "${input.workspaceName}" has been recovered.`,
    `${input.promotedEmail} is now its owner.`,
    "",
    "If you did not expect this change, contact your system administrator.",
  ].join("\n");
  for (const to of recipients) {
    try {
      await deliver({ to, subject, text });
    } catch (error) {
      log?.warn("ownership recovery notification failed", errorNameAndCode(error));
    }
  }
}

export function createOwnershipService({ db, deliver, log }: OwnershipDeps): OwnershipService {
  return {
    async directory(account) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireActiveAdministrator(tx, actor.humanId);
          const rows = await tx
            .select({
              id: workspaces.id,
              name: workspaces.name,
              createdAt: workspaces.createdAt,
            })
            .from(workspaces)
            .where(eq(workspaces.kind, WorkspaceKind.enum.shared))
            .orderBy(desc(workspaces.createdAt), desc(workspaces.id));
          if (rows.length === 0) return [];
          const ids = rows.map((row) => row.id);
          const membershipRows = await tx
            .select({
              workspaceId: workspaceMemberships.workspaceId,
              humanId: workspaceMemberships.humanId,
              email: humans.email,
              isOwner: workspaceMemberships.isOwner,
              isFormerOwner: workspaceMemberships.isFormerOwner,
              suspendedAt: workspaceMemberships.suspendedAt,
              accountDeactivated: sql<boolean>`${humans.deactivatedAt} is not null`,
            })
            .from(workspaceMemberships)
            .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
            .where(inArray(workspaceMemberships.workspaceId, ids))
            .orderBy(workspaceMemberships.createdAt, workspaceMemberships.humanId);
          const byWorkspace = new Map<string, InstallationWorkspaceMember[]>();
          for (const row of membershipRows) {
            const members = byWorkspace.get(row.workspaceId) ?? [];
            members.push({
              humanId: row.humanId,
              email: row.email,
              isOwner: row.isOwner,
              isFormerOwner: row.isFormerOwner,
              suspendedAt: row.suspendedAt?.toISOString() ?? null,
              accountDeactivated: row.accountDeactivated,
            });
            byWorkspace.set(row.workspaceId, members);
          }
          return rows.map((row): InstallationWorkspace => {
            const members = byWorkspace.get(row.id) ?? [];
            return {
              id: row.id,
              name: row.name,
              kind: "shared",
              createdAt: row.createdAt.toISOString(),
              hasActiveOwner: members.some(
                (member) => member.isOwner && member.suspendedAt === null,
              ),
              members,
            };
          });
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async recoverOwnership(account, workspaceId, targetHumanId) {
      const actor = requireAccount(account);
      const { workspaceName, ...result } = await db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        await requireActiveAdministrator(tx, actor.humanId);

        const [workspace] = await tx
          .select({ id: workspaces.id, name: workspaces.name, kind: workspaces.kind })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        if (workspace === undefined || workspace.kind !== WorkspaceKind.enum.shared) {
          throw new OwnershipError("workspace_not_found");
        }
        await bumpGuard(tx, workspaceId);

        if (targetHumanId === actor.humanId) {
          throw new OwnershipError("self_recovery_forbidden");
        }

        const [owners] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.isOwner, true),
              isNull(workspaceMemberships.suspendedAt),
            ),
          );
        if ((owners?.count ?? 0) >= 1) {
          throw new OwnershipError("workspace_has_active_owner");
        }

        const [target] = await tx
          .select({
            id: humans.id,
            email: humans.email,
            deactivatedAt: humans.deactivatedAt,
          })
          .from(humans)
          .where(eq(humans.id, targetHumanId))
          .limit(1)
          .for("update");
        if (target === undefined) throw new OwnershipError("human_not_found");

        if (target.deactivatedAt !== null) throw new OwnershipError("target_deactivated");

        const [membership] = await tx
          .select({
            id: workspaceMemberships.id,
            suspendedAt: workspaceMemberships.suspendedAt,
            isFormerOwner: workspaceMemberships.isFormerOwner,
          })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.humanId, targetHumanId),
            ),
          )
          .limit(1)
          .for("update");
        if (membership === undefined) throw new OwnershipError("member_not_found");

        const eligible =
          membership.suspendedAt === null ||
          (membership.suspendedAt !== null && membership.isFormerOwner);
        if (!eligible) throw new OwnershipError("recipient_ineligible");

        await tx
          .update(workspaceMemberships)
          .set({ isOwner: true, suspendedAt: null, isFormerOwner: false })
          .where(eq(workspaceMemberships.id, membership.id));

        const [event] = await tx
          .insert(workspaceEvents)
          .values({
            id: randomUUID(),
            workspaceId,
            type: "workspace_ownership_recovered",
            actorHumanId: actor.humanId,
            subjectHumanId: targetHumanId,
            createdAt: sql`statement_timestamp()`,
          })
          .returning({ createdAt: workspaceEvents.createdAt });
        await tx.insert(accountRecoveryEvents).values({
          id: randomUUID(),
          humanId: targetHumanId,
          actorHumanId: actor.humanId,
          type: "workspace_ownership_recovered",
          createdAt: sql`statement_timestamp()`,
        });

        return {
          workspaceId,
          workspaceName: workspace.name,
          humanId: targetHumanId,
          email: target.email,
          recoveredAt: (event?.createdAt ?? new Date()).toISOString(),
        };
      });

      await notifyMembers(db, deliver, log, {
        workspaceId: result.workspaceId,
        workspaceName,
        promotedEmail: result.email,
      });
      return result;
    },
  };
}
