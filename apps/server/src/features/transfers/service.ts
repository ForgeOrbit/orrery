import { randomBytes, randomUUID } from "node:crypto";
import type {
  Project,
  ProjectAccessLevel,
  TransferAccessChange,
  TransferAuthorization,
  TransferPreview,
} from "@orrery/contract";
import { InvitationStatus, ProjectAccessEventType, WorkspaceKind } from "@orrery/contract";
import { and, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agentApiKeyProjects,
  humans,
  issues,
  projectAccessEvents,
  projectAccessGrants,
  projectTransferAuthorizations,
  projects,
  questions,
  workSessions,
  workspaceEvents,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { tokenHash as hashToken } from "../../platform/tokens.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { transferAuthorizationMachine } from "./state-machine.ts";

// Personal-to-shared project transfer (#39). Every authority decision is here; the REST
// adapter only reads a human session and maps the result. Acceptance is one transaction:
// it takes the installation-wide ownership lock first, rechecks both authorities, that
// no live work remains and that the project still belongs to the source, then rebuilds
// access under the destination. Shared-to-shared (#46) reuses the same acceptance core.

export type TransfersErrorKind =
  | "not_signed_in"
  | "project_not_found"
  | "workspace_not_found"
  | "destination_authority_required"
  | "same_workspace"
  | "transfer_invalid"
  | "transfer_stale"
  | "source_authority_lost"
  | "active_work"
  | "project_key_conflict"
  | "project_key_immutable";

const messages: Record<TransfersErrorKind, string> = {
  not_signed_in: "Not signed in",
  project_not_found: "No project with this id is accessible to the caller",
  workspace_not_found: "No shared workspace with this id is accessible to the caller",
  destination_authority_required:
    "The receiver must be a destination owner or have Create projects in the destination",
  same_workspace: "The destination must be a different workspace from the source",
  transfer_invalid: "The transfer authorization is invalid, expired or already used",
  transfer_stale: "The project's workspace changed since the transfer was authorized",
  source_authority_lost: "The authorizing owner no longer controls the source workspace",
  active_work: "Finish or stop every active work session before transferring the project",
  project_key_conflict: "The destination workspace already uses this project key",
  project_key_immutable: "A project key can only change to resolve a transfer collision",
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
  receiverPreview(account: SessionAccount | null, token: string): Promise<TransferPreview>;
  // #95: `key` is the optional collision-resolving rename for the destination workspace.
  accept(account: SessionAccount | null, token: string, key?: string): Promise<Project>;
  complete(
    account: SessionAccount | null,
    projectId: string,
    destinationWorkspaceId: string,
    key?: string,
  ): Promise<Project>;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

interface Authority {
  project: ProjectRow;
  source: WorkspaceRow;
}

interface AuthorizationLike {
  id: string;
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

// A shared workspace's project is source-authorized only by one of its owners (#46).
// Membership and ownership are both checked here, so a non-member or a plain member gets
// the same `project_not_found` as a stranger probing an id: no workspace or project is
// enumerated, and no owner identity is implied by the answer.
async function readSharedSourceProject(
  tx: DbTransaction,
  projectId: string,
  humanId: string,
): Promise<Authority> {
  const [row] = await tx
    .select({ project: projects, source: workspaces })
    .from(projects)
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),
        eq(workspaceMemberships.isOwner, true),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(and(eq(projects.id, projectId), eq(workspaces.kind, WorkspaceKind.enum.shared)))
    .limit(1);
  if (row === undefined) throw new TransfersError("project_not_found");
  return row;
}

// The source owner is the personal workspace's single owner or a shared workspace's
// owner. The two kinds are never confused, and an inaccessible project answers as
// missing in both cases.
async function readSourceProject(
  tx: DbTransaction,
  projectId: string,
  humanId: string,
): Promise<Authority> {
  const [row] = await tx
    .select({ kind: workspaces.kind })
    .from(projects)
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row?.kind === WorkspaceKind.enum.shared) {
    return readSharedSourceProject(tx, projectId, humanId);
  }
  return readPersonalProject(tx, projectId, humanId);
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

function rejectSameWorkspace(sourceId: string, destinationId: string): void {
  if (sourceId === destinationId) throw new TransfersError("same_workspace");
}

// A shared workspace's name and membership are not public. Routes that reveal them must
// require membership first, so an arbitrary personal owner cannot enumerate destinations.
async function hasDestinationMembership(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [membership] = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

async function requireDestinationMember(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<void> {
  if (!(await hasDestinationMembership(tx, workspaceId, humanId))) {
    throw new TransfersError("workspace_not_found");
  }
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
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  return membership !== undefined && (membership.isOwner || membership.canCreateProjects);
}

// Destination owners and the receiver are the only Manage grants a transfer creates.
// A receiver is listed only when they can actually accept; an authorizer who is not a
// destination member learns nothing about who will receive the project.
async function manageRecipients(
  tx: DbTransaction,
  destinationWorkspaceId: string,
  receiverHumanId: string | null,
): Promise<TransferAccessChange[]> {
  const owners = await tx
    .select({ humanId: humans.id, email: humans.email })
    .from(workspaceMemberships)
    .innerJoin(humans, eq(workspaceMemberships.humanId, humans.id))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, destinationWorkspaceId),
        eq(workspaceMemberships.isOwner, true),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .orderBy(humans.email);
  const [receiver] =
    receiverHumanId === null
      ? []
      : await tx
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
  receiverHumanId: string | null,
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
    visibilityChange:
      authority.source.kind === WorkspaceKind.enum.personal
        ? "personal_to_shared"
        : "shared_to_shared",
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
    key: string;
    createdAt: Date;
    creatorId: string;
    creatorEmail: string;
    kind: Project["workspaceKind"];
    fallbackPolicy: Project["fallbackPolicy"];
  },
  accessLevel: ProjectAccessLevel,
): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    key: row.key,
    createdAt: row.createdAt.toISOString(),
    createdBy: {
      humanId: row.creatorId,
      email: row.creatorEmail,
      displayName: row.creatorEmail,
    },
    workspaceKind: row.kind,
    accessLevel,
    fallbackPolicy: row.fallbackPolicy,
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
      key: projects.key,
      createdAt: projects.createdAt,
      creatorId: humans.id,
      creatorEmail: humans.email,
      kind: workspaces.kind,
      fallbackPolicy: projects.fallbackPolicy,
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

// One insertion path for both the two-party authorization and the single-party direct
// flow, so the stored authorization and its source audit event can never drift apart.
async function createAuthorization(
  tx: DbTransaction,
  input: {
    projectId: string;
    sourceWorkspaceId: string;
    destinationWorkspaceId: string;
    authorizedByHumanId: string;
    token: string;
  },
) {
  const [authorization] = await tx
    .insert(projectTransferAuthorizations)
    .values({
      id: randomUUID(),
      projectId: input.projectId,
      sourceWorkspaceId: input.sourceWorkspaceId,
      destinationWorkspaceId: input.destinationWorkspaceId,
      authorizedByHumanId: input.authorizedByHumanId,
      tokenHash: hashToken(input.token),
      status: "pending",
      expiresAt: sql`statement_timestamp() + make_interval(secs => ${AUTHORIZATION_TTL_SECONDS})`,
    })
    .returning();
  if (authorization === undefined) throw new TransfersError("transfer_invalid");
  await tx
    .insert(workspaceEvents)
    .values(
      workspaceEvent(
        input.sourceWorkspaceId,
        "project_transfer_authorized",
        input.authorizedByHumanId,
        input.authorizedByHumanId,
      ),
    );
  return authorization;
}

// A token is a bearer secret for one pending authorization. Expiry is decided by the
// database clock, never the Node clock; a used or expired token answers as missing.
async function pendingAuthorizationByToken(
  tx: DbTransaction,
  token: string,
): Promise<typeof projectTransferAuthorizations.$inferSelect> {
  const [row] = await tx
    .select()
    .from(projectTransferAuthorizations)
    .where(eq(projectTransferAuthorizations.tokenHash, hashToken(token)))
    .limit(1);
  if (row === undefined || row.status !== "pending") throw new TransfersError("transfer_invalid");
  const [live] = await tx
    .select({ id: projectTransferAuthorizations.id })
    .from(projectTransferAuthorizations)
    .where(
      and(
        eq(projectTransferAuthorizations.id, row.id),
        gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  if (live === undefined) throw new TransfersError("transfer_invalid");
  return row;
}

// The acceptance core. The caller holds the ownership advisory lock; everything below
// runs on that same transaction, with no nested transaction. The project's activity
// (project_activity) is keyed by project id and follows the row automatically; this
// feature only adds destination-scoped grant events and workspace-scoped receipts.
async function acceptInTransaction(
  tx: DbTransaction,
  auth: AuthorizationLike,
  acceptorHumanId: string,
  newKey?: string,
): Promise<Project> {
  const [row] = await tx
    .select()
    .from(projectTransferAuthorizations)
    .where(eq(projectTransferAuthorizations.id, auth.id))
    .for("update")
    .limit(1);
  if (row === undefined || row.status !== "pending") {
    throw new TransfersError("transfer_invalid");
  }
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

  // The source row is needed below for the guard bump, but its authority is deliberately
  // rechecked *after* the destination gate. A leaked token in a stranger's hands must
  // answer as a missing authorization, never reveal that the source owner was demoted.
  const [source] = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, auth.sourceWorkspaceId))
    .limit(1);

  // The acceptor must hold a live membership in the destination. A valid token in the
  // hands of a stranger answers as a missing authorization, not as a workspace probe.
  if (!(await hasDestinationMembership(tx, auth.destinationWorkspaceId, acceptorHumanId))) {
    throw new TransfersError("transfer_invalid");
  }
  const destination = await readSharedDestination(tx, auth.destinationWorkspaceId);
  if (!(await hasCreateProjectsAuthority(tx, destination.id, acceptorHumanId))) {
    throw new TransfersError("destination_authority_required");
  }

  // Only a destination member with Create projects learns whether the source owner's
  // authority was lost (409); everyone else gets the two answers above first.
  if (source === undefined) throw new TransfersError("source_authority_lost");
  if (source.kind === WorkspaceKind.enum.personal) {
    // #39: the personal workspace's single owner must still own it.
    if (source.personalOwnerHumanId !== auth.authorizedByHumanId) {
      throw new TransfersError("source_authority_lost");
    }
  } else if (source.kind === WorkspaceKind.enum.shared) {
    // #46: the authorizer must still be an owner of the shared source. Being demoted or
    // removed between authorization and acceptance loses the authority to move the
    // project, so no stale token can complete the transfer.
    const [ownerMembership] = await tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, source.id),
          eq(workspaceMemberships.humanId, auth.authorizedByHumanId),
          eq(workspaceMemberships.isOwner, true),
          isNull(workspaceMemberships.suspendedAt),
        ),
      )
      .limit(1);
    if (ownerMembership === undefined) throw new TransfersError("source_authority_lost");
  } else {
    throw new TransfersError("source_authority_lost");
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

  // #95: a key is immutable except for a conflict-resolving rename during acceptance.
  // A replacement is only meaningful when this project's own key is already taken in the
  // destination; supplying one otherwise would be an ordinary rename by another route.
  // Both lookups run under the ownership lock and the project row lock.
  const [destinationKeyCollision] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, destination.id),
        eq(projects.key, project.key),
        ne(projects.id, auth.projectId),
      ),
    )
    .limit(1);
  const keyCollides = destinationKeyCollision !== undefined;
  if (newKey !== undefined && (!keyCollides || newKey === project.key)) {
    throw new TransfersError(keyCollides ? "project_key_conflict" : "project_key_immutable");
  }
  if (keyCollides && newKey === undefined) throw new TransfersError("project_key_conflict");
  const effectiveKey = newKey ?? project.key;
  if (newKey !== undefined) {
    const [replacementCollision] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, destination.id),
          eq(projects.key, newKey),
          ne(projects.id, auth.projectId),
        ),
      )
      .limit(1);
    if (replacementCollision !== undefined) throw new TransfersError("project_key_conflict");
  }

  const issueIds = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.projectId, auth.projectId))
    .orderBy(issues.id)
    .for("update");
  const issueIdList = issueIds.map((issue) => issue.id);
  if (issueIdList.length > 0) {
    const [liveSession] = await tx
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(
        and(
          inArray(workSessions.issueId, issueIdList),
          eq(workSessions.status, "active"),
          gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (liveSession !== undefined) throw new TransfersError("active_work");
    // No live claim remains, so materialize any lapsed leases. The destination must not
    // inherit rows that still say 'active' but point at the source workspace.
    await tx
      .update(workSessions)
      .set({
        status: "expired",
        endedAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      })
      .where(
        and(
          inArray(workSessions.issueId, issueIdList),
          eq(workSessions.status, "active"),
          lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        ),
      );
  }

  // Remove the old world in one shot: source grants, source keys' project scope and only
  // still-pending invitation offers naming the project. Settled invitations keep their
  // historical grants. Nothing here revives after a move back.
  await tx.delete(projectAccessGrants).where(eq(projectAccessGrants.projectId, auth.projectId));
  await tx.delete(agentApiKeyProjects).where(eq(agentApiKeyProjects.projectId, auth.projectId));
  const pendingOffers = await tx
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitationGrants)
    .innerJoin(
      workspaceInvitations,
      eq(workspaceInvitations.id, workspaceInvitationGrants.invitationId),
    )
    .where(
      and(
        eq(workspaceInvitationGrants.projectId, auth.projectId),
        eq(workspaceInvitations.status, InvitationStatus.enum.pending),
      ),
    );
  if (pendingOffers.length > 0) {
    await tx.delete(workspaceInvitationGrants).where(
      and(
        eq(workspaceInvitationGrants.projectId, auth.projectId),
        inArray(
          workspaceInvitationGrants.invitationId,
          pendingOffers.map((offer) => offer.id),
        ),
      ),
    );
  }

  // Move the identity and apply any collision-resolving rename in one UPDATE. Writing
  // the key separately would check the unique index against the old workspace, so a
  // replacement key that is free in the destination but used in the source would fail.
  // Issues, comments, knowledge, activity and runs key on the project id and follow the
  // row; questions denormalize workspace_id, so keep them synchronized with the move.
  await tx
    .update(projects)
    .set({ workspaceId: destination.id, key: effectiveKey })
    .where(eq(projects.id, auth.projectId));
  await tx
    .update(questions)
    .set({ workspaceId: destination.id })
    .where(eq(questions.projectId, auth.projectId));

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
      // The grant belongs to the destination from this point on. The source's earlier
      // access events keep their own workspace_id and never surface here (#46).
      workspaceId: destination.id,
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

  transferAuthorizationMachine.assertTransition("pending", "accepted");
  await tx
    .update(projectTransferAuthorizations)
    .set({
      status: "accepted",
      acceptedAt: sql`statement_timestamp()`,
    })
    .where(eq(projectTransferAuthorizations.id, auth.id));
  // A project can be authorized for several destinations; only one can win. Every other
  // pending authorization is revoked, never revived into access after a later move.
  transferAuthorizationMachine.assertTransition("pending", "revoked");
  await tx
    .update(projectTransferAuthorizations)
    .set({
      status: "revoked",
      revokedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(projectTransferAuthorizations.projectId, auth.projectId),
        eq(projectTransferAuthorizations.status, "pending"),
        ne(projectTransferAuthorizations.id, auth.id),
      ),
    );

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
          const authority = await readSourceProject(tx, projectId, account.humanId);
          rejectSameWorkspace(authority.source.id, destinationWorkspaceId);
          // Membership first: a destination's name and owners are not public data.
          await requireDestinationMember(tx, destinationWorkspaceId, account.humanId);
          const destination = await readSharedDestination(tx, destinationWorkspaceId);
          const receiver = (await hasCreateProjectsAuthority(tx, destination.id, account.humanId))
            ? account.humanId
            : null;
          return buildPreview(tx, authority, destination, receiver);
        },
        { accessMode: "read only" },
      );
    },

    async authorize(account, projectId, destinationWorkspaceId) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const authority = await readSourceProject(tx, projectId, account.humanId);
        rejectSameWorkspace(authority.source.id, destinationWorkspaceId);
        const destination = await readSharedDestination(tx, destinationWorkspaceId);
        // The authorizer may not belong to the destination at all. Only a member may see
        // its name and owners; a non-member gets a token and no destination detail.
        const canSeeDestination = await hasDestinationMembership(
          tx,
          destination.id,
          account.humanId,
        );
        const receiver = (await hasCreateProjectsAuthority(tx, destination.id, account.humanId))
          ? account.humanId
          : null;
        const fullPreview = await buildPreview(tx, authority, destination, receiver);
        const token = randomBytes(32).toString("base64url");
        const authorization = await createAuthorization(tx, {
          projectId,
          sourceWorkspaceId: authority.source.id,
          destinationWorkspaceId: destination.id,
          authorizedByHumanId: account.humanId,
          token,
        });

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
          preview: canSeeDestination ? fullPreview : null,
        };
      });
    },

    async receiverPreview(account, token) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(
        async (tx) => {
          const authorization = await pendingAuthorizationByToken(tx, token);
          // The receiver's view is gated by the destination, not the source. A non-member
          // gets the same 404 as a stranger probing any other workspace by id: the token
          // is the only capability here, so membership alone must not be revealed.
          if (
            !(await hasDestinationMembership(
              tx,
              authorization.destinationWorkspaceId,
              account.humanId,
            ))
          ) {
            throw new TransfersError("transfer_invalid");
          }
          if (
            !(await hasCreateProjectsAuthority(
              tx,
              authorization.destinationWorkspaceId,
              account.humanId,
            ))
          ) {
            throw new TransfersError("destination_authority_required");
          }
          const [project] = await tx
            .select()
            .from(projects)
            .where(eq(projects.id, authorization.projectId))
            .limit(1);
          const [source] = await tx
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, authorization.sourceWorkspaceId))
            .limit(1);
          if (project === undefined || source === undefined) {
            throw new TransfersError("transfer_invalid");
          }
          const destination = await readSharedDestination(tx, authorization.destinationWorkspaceId);
          return buildPreview(tx, { project, source }, destination, account.humanId);
        },
        { accessMode: "read only" },
      );
    },

    async accept(account, token, key) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const row = await pendingAuthorizationByToken(tx, token);
        return acceptInTransaction(tx, row, account.humanId, key);
      });
    },

    async complete(account, projectId, destinationWorkspaceId, key) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const authority = await readSourceProject(tx, projectId, account.humanId);
        rejectSameWorkspace(authority.source.id, destinationWorkspaceId);
        // Membership before capability: a non-member cannot enumerate the destination
        // through a 403 that would confirm the workspace exists.
        await requireDestinationMember(tx, destinationWorkspaceId, account.humanId);
        const destination = await readSharedDestination(tx, destinationWorkspaceId);
        if (!(await hasCreateProjectsAuthority(tx, destination.id, account.humanId))) {
          throw new TransfersError("destination_authority_required");
        }
        const token = randomBytes(32).toString("base64url");
        const authorization = await createAuthorization(tx, {
          projectId,
          sourceWorkspaceId: authority.source.id,
          destinationWorkspaceId: destination.id,
          authorizedByHumanId: account.humanId,
          token,
        });
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
          key,
        );
      });
    },
  };
}
