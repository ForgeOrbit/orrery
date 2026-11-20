import { randomBytes, randomUUID } from "node:crypto";
import type {
  Project,
  ProjectAccessLevel,
  TransferAccessChange,
  TransferAuthorization,
  TransferPreview,
} from "@orrery/contract";
import { ProjectAccessEventType, WorkspaceKind } from "@orrery/contract";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agentApiKeyProjects,
  humans,
  issues,
  projectAccessEvents,
  projectAccessGrants,
  projectTransferAuthorizations,
  projects,
  workSessions,
  workspaceEvents,
  workspaceInvitationGrants,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { tokenHash as hashToken } from "../../platform/tokens.ts";
import type { SessionAccount } from "../accounts/index.ts";

// Personal-to-shared project transfer (#39). Every authority decision is here; the REST
// adapter only reads a human session and maps the result. Acceptance is one transaction:
// it takes the installation-wide ownership lock first, rechecks both authorities, that
// no live work remains and that the project still belongs to the source, then rebuilds
// access under the destination. Shared-to-shared (#46) reuses the same acceptance core.

export type TransfersErrorKind =
  | "not_signed_in"
  | "project_not_found"
  | "workspace_not_found"
  | "not_personal_project_owner"
  | "destination_authority_required"
  | "transfer_invalid"
  | "transfer_stale"
  | "source_authority_lost"
  | "active_work";

const messages: Record<TransfersErrorKind, string> = {
  not_signed_in: "Not signed in",
  project_not_found: "No project with this id is accessible to the caller",
  workspace_not_found: "No shared workspace with this id is accessible to the caller",
  not_personal_project_owner:
    "Only the owner of the personal workspace may authorize this transfer",
  destination_authority_required:
    "The receiver must be a destination owner or have Create projects in the destination",
  transfer_invalid: "The transfer authorization is invalid, expired or already used",
  transfer_stale: "The project's workspace changed since the transfer was authorized",
  source_authority_lost: "The authorizing owner no longer controls the source workspace",
  active_work: "Finish or stop every active work session before transferring the project",
};

export class TransfersError extends Error {
  readonly kind: TransfersErrorKind;
  constructor(kind: TransfersErrorKind) {
    super(messages[kind]);
    this.name = "TransfersError";
    this.kind = kind;
  }
}

// Seven days, mirroring invitations. Evaluated in database time at acceptance, and no
// test waits out the period — fixtures are placed just before and just after it.
const AUTHORIZATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TransfersDeps {
  db: PostgresJsDatabase;
}

export interface TransfersService {
  preview(
    account: SessionAccount | null,
    projectId: string,
    destinationWorkspaceId: string,
  ): Promise<TransferPreview>;
  authorize(
    account: SessionAccount | null,
    projectId: string,
    destinationWorkspaceId: string,
  ): Promise<TransferAuthorization>;
  accept(account: SessionAccount | null, token: string): Promise<Project>;
  complete(
    account: SessionAccount | null,
    projectId: string,
    destinationWorkspaceId: string,
  ): Promise<Project>;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

interface Authority {
  project: ProjectRow;
  source: WorkspaceRow;
}

interface AuthorizationLike {
  id?: string;
  projectId: string;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  authorizedByHumanId: string;
}

// The installation-wide advisory lock must be the first lock an ownership mutation
// takes (migration 0008), and guard rows are advanced in ascending id order (0007).
async function lockOwnershipWrites(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function bumpGuards(tx: DbTransaction, ids: readonly string[]): Promise<void> {
  for (const workspaceId of ids.toSorted()) {
    await tx
      .insert(workspaceOwnershipGuards)
      .values({ workspaceId, version: 0 })
      .onConflictDoUpdate({
        target: workspaceOwnershipGuards.workspaceId,
        set: { version: sql`${workspaceOwnershipGuards.version} + 1` },
      });
  }
}

// A personal project is owned by exactly one human through their personal workspace;
// there is no membership row to enumerate. An inaccessible id answers as missing.
async function readPersonalProject(
  tx: DbTransaction,
  projectId: string,
  humanId: string,
): Promise<Authority> {
  const [row] = await tx
    .select({ project: projects, source: workspaces })
    .from(projects)
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .where(
      and(
        eq(projects.id, projectId),
        eq(workspaces.kind, WorkspaceKind.enum.personal),
        eq(workspaces.personalOwnerHumanId, humanId),
      ),
    )
    .limit(1);
  if (row === undefined) throw new TransfersError("project_not_found");
  return row;
}

async function readSharedDestination(
  tx: DbTransaction,
  workspaceId: string,
): Promise<WorkspaceRow> {
  const [row] = await tx
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, WorkspaceKind.enum.shared)))
    .limit(1);
  if (row === undefined) throw new TransfersError("workspace_not_found");
  return row;
}

// Owners hold Create projects implicitly; a member holds it only when granted. The
// membership and the capability are both rechecked at acceptance, never cached from
// authorization time.
async function hasCreateProjectsAuthority(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [membership] = await tx
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .limit(1);
  return membership !== undefined && (membership.isOwner || membership.canCreateProjects);
}

// Destination owners and the receiver are the only Manage grants a transfer creates.
// The receiver is listed once even when they are already an owner.
async function manageRecipients(
  tx: DbTransaction,
  destinationWorkspaceId: string,
  receiverHumanId: string,
): Promise<TransferAccessChange[]> {
  const owners = await tx
    .select({ humanId: humans.id, email: humans.email })
    .from(workspaceMemberships)
    .innerJoin(humans, eq(workspaceMemberships.humanId, humans.id))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, destinationWorkspaceId),
        eq(workspaceMemberships.isOwner, true),
      ),
    )
    .orderBy(humans.email);
  const [receiver] = await tx
    .select({ humanId: humans.id, email: humans.email })
    .from(humans)
    .where(eq(humans.id, receiverHumanId))
    .limit(1);

  const changes: TransferAccessChange[] = [];
  const seen = new Set<string>();
  for (const owner of owners) {
    if (seen.has(owner.humanId)) continue;
    seen.add(owner.humanId);
    changes.push({
      humanId: owner.humanId,
      email: owner.email,
      level: "manage",
      reason: "destination_owner",
    });
  }
  if (receiver !== undefined && !seen.has(receiver.humanId)) {
    changes.push({
      humanId: receiver.humanId,
      email: receiver.email,
      level: "manage",
      reason: "receiver",
    });
  }
  return changes;
}

// A session is live only while its lease is ahead of database time. The same predicate
// the work-sessions feature uses for claims gates the transfer here; a lapsed claim does
// not block, and is never revived by the transfer.
async function liveWork(
  tx: DbTransaction,
  projectId: string,
): Promise<{ issueId: string; number: number; title: string }[]> {
  return tx
    .select({ issueId: issues.id, number: issues.number, title: issues.title })
    .from(workSessions)
    .innerJoin(issues, eq(workSessions.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(workSessions.status, "active"),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    )
    .orderBy(issues.number);
}

function toParty(workspace: WorkspaceRow) {
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
  };
}

async function buildPreview(
  tx: DbTransaction,
  authority: Authority,
  destination: WorkspaceRow,
  receiverHumanId: string,
): Promise<TransferPreview> {
  const [grants] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(projectAccessGrants)
    .where(eq(projectAccessGrants.projectId, authority.project.id));
  const active = await liveWork(tx, authority.project.id);
  return {
    projectId: authority.project.id,
    projectName: authority.project.name,
    source: toParty(authority.source),
    destination: toParty(destination),
    visibilityChange: "personal_to_shared",
    accessChanges: await manageRecipients(tx, destination.id, receiverHumanId),
    revokedSourceGrants: grants?.count ?? 0,
    activeWork: { count: active.length, issues: active },
    ready: active.length === 0,
  };
}

function toProject(
  row: {
    id: string;
    workspaceId: string;
    name: string;
    createdAt: Date;
    creatorId: string;
    creatorEmail: string;
    kind: Project["workspaceKind"];
  },
  accessLevel: ProjectAccessLevel,
): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    createdBy: {
      humanId: row.creatorId,
      email: row.creatorEmail,
      displayName: row.creatorEmail,
    },
    workspaceKind: row.kind,
    accessLevel,
  };
}

async function readProjectView(
  tx: DbTransaction,
  projectId: string,
  accessLevel: ProjectAccessLevel,
): Promise<Project> {
  const [row] = await tx
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      name: projects.name,
      createdAt: projects.createdAt,
      creatorId: humans.id,
      creatorEmail: humans.email,
      kind: workspaces.kind,
    })
    .from(projects)
    .innerJoin(humans, eq(projects.createdByHumanId, humans.id))
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row === undefined) throw new TransfersError("project_not_found");
  return toProject(row, accessLevel);
}

function workspaceEvent(
  workspaceId: string,
  type: "project_transfer_authorized" | "project_transfer_received" | "project_transferred_out",
  actorHumanId: string,
  subjectHumanId: string,
) {
  return {
    id: randomUUID(),
    workspaceId,
    type,
    actorHumanId,
    subjectHumanId,
    createdAt: sql`statement_timestamp()`,
  };
}

// The acceptance core. The caller holds the ownership advisory lock; everything below
// runs on that same transaction, with no nested transaction. The project's activity
// (project_activity) is keyed by project id and follows the row automatically; this
// feature only adds destination-scoped grant events and workspace-scoped receipts.
async function acceptInTransaction(
  tx: DbTransaction,
  auth: AuthorizationLike,
  acceptorHumanId: string,
): Promise<Project> {
  if (auth.id !== undefined) {
    const [row] = await tx
      .select()
      .from(projectTransferAuthorizations)
      .where(eq(projectTransferAuthorizations.id, auth.id))
      .for("update")
      .limit(1);
    if (row === undefined || row.status !== "pending") {
      throw new TransfersError("transfer_invalid");
    }
    // Expiry is decided by the database clock, never the Node clock.
    const [live] = await tx
      .select({ id: projectTransferAuthorizations.id })
      .from(projectTransferAuthorizations)
      .where(
        and(
          eq(projectTransferAuthorizations.id, auth.id),
          gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (live === undefined) throw new TransfersError("transfer_invalid");
  }

  const [source] = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, auth.sourceWorkspaceId))
    .limit(1);
  if (
    source === undefined ||
    source.kind !== WorkspaceKind.enum.personal ||
    source.personalOwnerHumanId !== auth.authorizedByHumanId
  ) {
    throw new TransfersError("source_authority_lost");
  }

  const destination = await readSharedDestination(tx, auth.destinationWorkspaceId);
  if (!(await hasCreateProjectsAuthority(tx, destination.id, acceptorHumanId))) {
    throw new TransfersError("destination_authority_required");
  }

  // Workspace guards before the project row, then issues: one deterministic order.
  await bumpGuards(tx, [source.id, destination.id]);

  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, auth.projectId))
    .for("update")
    .limit(1);
  if (project === undefined || project.workspaceId !== auth.sourceWorkspaceId) {
    throw new TransfersError("transfer_stale");
  }

  const issueIds = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.projectId, auth.projectId))
    .orderBy(issues.id)
    .for("update");
  if (issueIds.length > 0) {
    const [live] = await tx
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(
        and(
          inArray(
            workSessions.issueId,
            issueIds.map((issue) => issue.id),
          ),
          eq(workSessions.status, "active"),
          gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (live !== undefined) throw new TransfersError("active_work");
  }

  // Remove the old world in one shot: source grants, source keys' project scope and any
  // pending invitation offers naming the project. Nothing here revives after a move back.
  await tx.delete(projectAccessGrants).where(eq(projectAccessGrants.projectId, auth.projectId));
  await tx.delete(agentApiKeyProjects).where(eq(agentApiKeyProjects.projectId, auth.projectId));
  await tx
    .delete(workspaceInvitationGrants)
    .where(eq(workspaceInvitationGrants.projectId, auth.projectId));

  // Move the identity. Issues, comments, knowledge, activity and runs all key on the
  // project id, so the whole history travels with this one row change.
  await tx
    .update(projects)
    .set({ workspaceId: destination.id })
    .where(eq(projects.id, auth.projectId));

  const recipients = await manageRecipients(tx, destination.id, acceptorHumanId);
  for (const recipient of recipients) {
    await tx.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: auth.projectId,
      humanId: recipient.humanId,
      level: "manage",
      grantedByHumanId: acceptorHumanId,
      createdAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    });
    await tx.insert(projectAccessEvents).values({
      id: randomUUID(),
      projectId: auth.projectId,
      actorHumanId: acceptorHumanId,
      subjectHumanId: recipient.humanId,
      type: ProjectAccessEventType.enum.project_access_granted,
      level: "manage",
      previousLevel: null,
      createdAt: sql`statement_timestamp()`,
    });
  }

  // Source access history stays in the source: this event carries no project-scoped
  // membership detail. The destination records its own receipt, and the grant events
  // above are project-scoped in the destination from this point on.
  await tx
    .insert(workspaceEvents)
    .values(
      workspaceEvent(
        source.id,
        "project_transferred_out",
        auth.authorizedByHumanId,
        acceptorHumanId,
      ),
    );
  await tx
    .insert(workspaceEvents)
    .values(
      workspaceEvent(
        destination.id,
        "project_transfer_received",
        acceptorHumanId,
        auth.authorizedByHumanId,
      ),
    );

  if (auth.id !== undefined) {
    await tx
      .update(projectTransferAuthorizations)
      .set({ status: "accepted", acceptedAt: sql`statement_timestamp()` })
      .where(eq(projectTransferAuthorizations.id, auth.id));
  }

  // Project activity deliberately keeps its original attribution (createdByHumanId), so
  // authorship survives the move without a rewritten receipt in the project's own feed.
  return readProjectView(tx, auth.projectId, "manage");
}

export function createTransfersService({ db }: TransfersDeps): TransfersService {
  return {
    async preview(account, projectId, destinationWorkspaceId) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(
        async (tx) => {
          const authority = await readPersonalProject(tx, projectId, account.humanId);
          const destination = await readSharedDestination(tx, destinationWorkspaceId);
          return buildPreview(tx, authority, destination, account.humanId);
        },
        { accessMode: "read only" },
      );
    },

    async authorize(account, projectId, destinationWorkspaceId) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const authority = await readPersonalProject(tx, projectId, account.humanId);
        const destination = await readSharedDestination(tx, destinationWorkspaceId);
        const preview = await buildPreview(tx, authority, destination, account.humanId);

        const token = randomBytes(32).toString("base64url");
        const [authorization] = await tx
          .insert(projectTransferAuthorizations)
          .values({
            id: randomUUID(),
            projectId,
            sourceWorkspaceId: authority.source.id,
            destinationWorkspaceId: destination.id,
            authorizedByHumanId: account.humanId,
            tokenHash: hashToken(token),
            status: "pending",
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${AUTHORIZATION_TTL_SECONDS})`,
          })
          .returning();
        if (authorization === undefined) throw new TransfersError("transfer_invalid");
        await tx
          .insert(workspaceEvents)
          .values(
            workspaceEvent(
              authority.source.id,
              "project_transfer_authorized",
              account.humanId,
              account.humanId,
            ),
          );

        return {
          token,
          authorizationId: authorization.id,
          projectId,
          sourceWorkspaceId: authority.source.id,
          destinationWorkspaceId: destination.id,
          authorizedByHumanId: account.humanId,
          status: authorization.status,
          createdAt: authorization.createdAt.toISOString(),
          expiresAt: authorization.expiresAt.toISOString(),
          preview,
        };
      });
    },

    async accept(account, token) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const [row] = await tx
          .select()
          .from(projectTransferAuthorizations)
          .where(eq(projectTransferAuthorizations.tokenHash, hashToken(token)))
          .limit(1);
        if (row === undefined) throw new TransfersError("transfer_invalid");
        return acceptInTransaction(tx, row, account.humanId);
      });
    },

    async complete(account, projectId, destinationWorkspaceId) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const authority = await readPersonalProject(tx, projectId, account.humanId);
        const destination = await readSharedDestination(tx, destinationWorkspaceId);
        // One party with both authorities finishes directly; still no Create projects
        // means the destination has not accepted the incoming project.
        if (!(await hasCreateProjectsAuthority(tx, destination.id, account.humanId))) {
          throw new TransfersError("destination_authority_required");
        }
        const token = randomBytes(32).toString("base64url");
        const [authorization] = await tx
          .insert(projectTransferAuthorizations)
          .values({
            id: randomUUID(),
            projectId,
            sourceWorkspaceId: authority.source.id,
            destinationWorkspaceId: destination.id,
            authorizedByHumanId: account.humanId,
            tokenHash: hashToken(token),
            status: "pending",
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${AUTHORIZATION_TTL_SECONDS})`,
          })
          .returning();
        if (authorization === undefined) throw new TransfersError("transfer_invalid");
        await tx
          .insert(workspaceEvents)
          .values(
            workspaceEvent(
              authority.source.id,
              "project_transfer_authorized",
              account.humanId,
              account.humanId,
            ),
          );
        return acceptInTransaction(
          tx,
          {
            id: authorization.id,
            projectId: authorization.projectId,
            sourceWorkspaceId: authorization.sourceWorkspaceId,
            destinationWorkspaceId: authorization.destinationWorkspaceId,
            authorizedByHumanId: account.humanId,
          },
          account.humanId,
        );
      });
    },
  };
}
