import { randomBytes, randomUUID } from "node:crypto";
import {
  InvitationDelivery,
  InvitationStatus,
  WorkspaceKind,
  type CreateWorkspaceRequest,
  type InviteWorkspaceMemberRequest,
  type Workspace,
  type WorkspaceInvitation,
  type WorkspaceInvitationPreview,
  type WorkspaceMember,
} from "@orrery/contract";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode, uniqueConstraintName } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import type { SessionAccount } from "../accounts/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import {
  humans,
  workspaceEvents,
  workspaceInvitations,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
  type WorkspaceEventType,
} from "../../db/schema.ts";

// The service is the only file in a feature that decides anything. rest.ts calls it.

// Seven days, evaluated in database time at redemption, never by a deployed clock (#20).
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type WorkspacesErrorKind =
  | "not_signed_in"
  | "workspace_not_found"
  | "not_workspace_owner"
  | "inviter_unverified"
  | "inviter_not_authorized"
  | "invitation_invalid"
  | "invitation_recipient_mismatch"
  | "email_unverified"
  | "invitation_pending"
  | "already_member"
  | "account_exists"
  | "member_not_found"
  | "last_owner";

// Each kind is the REST error's stable code and its message the Problem's title
// (ADR-0003), so clients branch on the code and people read the title.
const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  not_workspace_owner: "Only a workspace owner can do that.",
  inviter_unverified: "Verify your own email before inviting someone to a workspace.",
  inviter_not_authorized:
    "The person who sent this invitation can no longer invite to this workspace.",
  invitation_invalid: "This workspace invitation is invalid, expired, or already used.",
  invitation_recipient_mismatch: "This invitation was sent to a different email address.",
  email_unverified: "Verify this account's email before accepting the invitation.",
  invitation_pending: "An invitation for this email is already pending in this workspace.",
  already_member: "This person is already a member of the workspace.",
  account_exists: "This email already has an account. Sign in to accept the invitation.",
  member_not_found: "This person is not a member of the workspace.",
  last_owner: "A workspace must keep at least one owner.",
} as const satisfies Record<WorkspacesErrorKind, string>;

export class WorkspacesError extends Error {
  readonly kind: WorkspacesErrorKind;

  constructor(kind: WorkspacesErrorKind) {
    super(messages[kind]);
    this.name = "WorkspacesError";
    this.kind = kind;
  }
}

// The emailed link. Plain text like every email the installation sends; following it
// (GET) changes nothing, and acceptance or registration is the POST that consumes it.
function invitationMail(
  workspaceName: string,
  email: string,
  token: string,
  publicUrl: string,
): OutgoingMail {
  return {
    to: email,
    subject: "Your Orrery workspace invitation",
    text: [
      `You have been invited to join the workspace "${workspaceName}" on Orrery as ${email}.`,
      "",
      "Follow the link to see the invitation:",
      "",
      `${publicUrl}/workspace-invitation?token=${token}`,
      "",
      "If you already have an Orrery account, sign in with this address and accept.",
      "If you are new, choose a password there to create your account, personal workspace, and membership.",
      "",
      "The link is valid for seven days. Opening it changes nothing.",
      "",
      "If you did not expect this invitation, ignore it.",
    ].join("\n"),
  };
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new WorkspacesError("not_signed_in");
  return account;
}

// Records one access-change event inside the caller's transaction, so the event and the
// change it describes commit together or not at all.
async function recordEvent(
  tx: DbTransaction,
  type: WorkspaceEventType,
  workspaceId: string,
  actorHumanId: string,
  subjectHumanId: string,
) {
  await tx.insert(workspaceEvents).values({
    id: randomUUID(),
    workspaceId,
    type,
    actorHumanId,
    subjectHumanId,
  });
}

// A read-only shared workspace lookup: no guard or row lock, because it decides nothing
// and changing ownership concurrently may only make this response momentarily stale.
async function readSharedWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  missingKind: "workspace_not_found" | "invitation_invalid" = "workspace_not_found",
) {
  const [workspace] = await tx
    .select({ id: workspaces.id, kind: workspaces.kind, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (workspace === undefined || workspace.kind !== WorkspaceKind.enum.shared) {
    throw new WorkspacesError(missingKind);
  }
  return workspace;
}

// Acquire the same transaction lock as direct ownership statements before taking any
// row locks. The per-workspace version below still detects stale REPEATABLE READ writers.
async function lockOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function lockWorkspaceForMutation(
  tx: DbTransaction,
  workspaceId: string,
  missingKind: "workspace_not_found" | "invitation_invalid" = "workspace_not_found",
) {
  await lockOwnershipWrites(tx);
  const workspace = await readSharedWorkspace(tx, workspaceId, missingKind);
  await tx
    .insert(workspaceOwnershipGuards)
    .values({ workspaceId, version: 0 })
    .onConflictDoUpdate({
      target: workspaceOwnershipGuards.workspaceId,
      set: { version: sql`${workspaceOwnershipGuards.version} + 1` },
    });
  return workspace;
}

// The caller's authority is read after the workspace lock, never from a stale snapshot:
// an owner removed by the transaction ahead of this one is no longer an owner here.
async function requireOwner(tx: DbTransaction, workspaceId: string, humanId: string) {
  const [membership] = await tx
    .select({ isOwner: workspaceMemberships.isOwner })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .limit(1);
  if (membership?.isOwner !== true) throw new WorkspacesError("not_workspace_owner");
}

// #20's acceptance rule: the inviter's authority is rechecked when the offer is taken
// up, not only when it was sent. An inviter who left the workspace or lost ownership
// cannot still hand out access.
async function requireInviterStillAuthorized(
  tx: DbTransaction,
  workspaceId: string,
  inviterHumanId: string,
) {
  const [inviter] = await tx
    .select({
      isOwner: workspaceMemberships.isOwner,
      emailVerifiedAt: humans.emailVerifiedAt,
    })
    .from(workspaceMemberships)
    .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, inviterHumanId),
      ),
    )
    .limit(1);
  if (inviter?.isOwner !== true || inviter.emailVerifiedAt === null) {
    throw new WorkspacesError("inviter_not_authorized");
  }
}

// The listing projection: personal owners are owners by definition; a shared workspace
// is the caller's membership, with its owner flag.
function toWorkspace(row: {
  id: string;
  kind: Workspace["kind"];
  name: string;
  membershipIsOwner: boolean | null;
}): Workspace {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isOwner: row.kind === WorkspaceKind.enum.personal || row.membershipIsOwner === true,
  };
}

export interface WorkspacesDeps {
  db: PostgresJsDatabase;
  // The URL the emailed link carries.
  publicUrl: string;
  // Accounts owns humans: invited registration creates the account and personal
  // workspace, and the verified mark is earned by the invitation token.
  createInvitedHuman: (
    input: { email: string; password: string },
    tx: DbTransaction,
  ) => Promise<{ humanId: string }>;
  markEmailVerified: (humanId: string, tx: DbTransaction) => Promise<void>;
  // Settings owns the relay: the one mail path, never a second transport.
  deliver: (mail: OutgoingMail) => Promise<void>;
  log?: Logger;
}

export interface WorkspacesService {
  list(account: SessionAccount | null): Promise<Workspace[]>;
  get(account: SessionAccount | null, workspaceId: string): Promise<Workspace>;
  members(account: SessionAccount | null, workspaceId: string): Promise<WorkspaceMember[]>;
  create(account: SessionAccount | null, input: CreateWorkspaceRequest): Promise<Workspace>;
  invite(
    account: SessionAccount | null,
    workspaceId: string,
    input: InviteWorkspaceMemberRequest,
  ): Promise<WorkspaceInvitation>;
  previewInvitation(token: string): Promise<WorkspaceInvitationPreview>;
  acceptInvitation(account: SessionAccount | null, token: string): Promise<Workspace>;
  registerThroughInvitation(input: {
    token: string;
    password: string;
  }): Promise<{ email: string; emailVerified: true }>;
  appointOwner(
    account: SessionAccount | null,
    workspaceId: string,
    humanId: string,
  ): Promise<WorkspaceMember>;
  removeMember(account: SessionAccount | null, workspaceId: string, humanId: string): Promise<void>;
}

// The delivery attempt, recorded separately from the lifecycle: pending never implies
// delivered (#20). Only a recorded failure never redeems.
async function recordDelivery(db: PostgresJsDatabase, id: string, delivery: InvitationDelivery) {
  await db
    .update(workspaceInvitations)
    .set({ deliveryStatus: delivery, deliveryAttemptedAt: sql`statement_timestamp()` })
    .where(eq(workspaceInvitations.id, id));
}

// One token transition for both redemption paths. The workspace is located from the
// token, locked first, and only then is the invitation conditionally consumed; invite
// replacement takes the same workspace lock, so the two paths cannot interleave their
// invitation reads and writes. The inviter's authority is rechecked in this transaction
// after the transition; if it fails, the whole transaction rolls the token back to
// pending rather than burning it.
async function redeemWorkspaceInvitation(tx: DbTransaction, token: string) {
  const [located] = await tx
    .select({ workspaceId: workspaceInvitations.workspaceId })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.tokenHash, tokenHash(token)))
    .limit(1);
  if (located === undefined) throw new WorkspacesError("invitation_invalid");

  const workspace = await lockWorkspaceForMutation(tx, located.workspaceId, "invitation_invalid");

  // Email delivery can update this row without taking the ownership lock. Wait for
  // it before starting the statement that samples the deadline and acceptance time.
  const [locked] = await tx
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.tokenHash, tokenHash(token)),
        eq(workspaceInvitations.workspaceId, located.workspaceId),
      ),
    )
    .for("update");
  if (locked === undefined) throw new WorkspacesError("invitation_invalid");

  const [invitation] = await tx
    .update(workspaceInvitations)
    .set({ status: InvitationStatus.enum.accepted, acceptedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(workspaceInvitations.tokenHash, tokenHash(token)),
        eq(workspaceInvitations.workspaceId, located.workspaceId),
        eq(workspaceInvitations.status, InvitationStatus.enum.pending),
        gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
        sql`${workspaceInvitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
      ),
    )
    .returning({
      workspaceId: workspaceInvitations.workspaceId,
      email: workspaceInvitations.email,
      invitedByHumanId: workspaceInvitations.invitedByHumanId,
    });
  if (invitation === undefined) throw new WorkspacesError("invitation_invalid");

  await requireInviterStillAuthorized(tx, invitation.workspaceId, invitation.invitedByHumanId);
  return { ...invitation, workspace };
}

export function createWorkspacesService({
  db,
  publicUrl,
  createInvitedHuman,
  markEmailVerified,
  deliver,
  log,
}: WorkspacesDeps): WorkspacesService {
  return {
    // Access is what the caller holds, not what exists: their personal workspace plus the
    // shared workspaces they belong to. Another person's workspace never appears.
    async list(account) {
      if (account === null) throw new WorkspacesError("not_signed_in");
      const rows = await db
        .select({
          id: workspaces.id,
          kind: workspaces.kind,
          name: workspaces.name,
          membershipIsOwner: workspaceMemberships.isOwner,
        })
        .from(workspaces)
        .leftJoin(
          workspaceMemberships,
          and(
            eq(workspaceMemberships.workspaceId, workspaces.id),
            eq(workspaceMemberships.humanId, account.humanId),
          ),
        )
        .where(
          or(
            eq(workspaces.personalOwnerHumanId, account.humanId),
            eq(workspaceMemberships.humanId, account.humanId),
          ),
        )
        .orderBy(workspaces.createdAt, workspaces.id);
      return rows.map(toWorkspace);
    },

    // One workspace, but only through the caller's own access. A non-member gets the
    // same answer as a missing workspace, so the endpoint cannot enumerate workspaces.
    async get(account, workspaceId) {
      if (account === null) throw new WorkspacesError("not_signed_in");
      const [row] = await db
        .select({
          id: workspaces.id,
          kind: workspaces.kind,
          name: workspaces.name,
          membershipIsOwner: workspaceMemberships.isOwner,
        })
        .from(workspaces)
        .leftJoin(
          workspaceMemberships,
          and(
            eq(workspaceMemberships.workspaceId, workspaces.id),
            eq(workspaceMemberships.humanId, account.humanId),
          ),
        )
        .where(
          and(
            eq(workspaces.id, workspaceId),
            or(
              eq(workspaces.personalOwnerHumanId, account.humanId),
              eq(workspaceMemberships.humanId, account.humanId),
            ),
          ),
        )
        .limit(1);
      if (row === undefined) throw new WorkspacesError("workspace_not_found");
      return toWorkspace(row);
    },

    // The member directory an owner uses to appoint or remove people. Owners only: an
    // ordinary member does not need everyone else's address to do their work.
    async members(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await readSharedWorkspace(tx, workspaceId);
          await requireOwner(tx, workspaceId, actor.humanId);
          return tx
            .select({
              humanId: workspaceMemberships.humanId,
              email: humans.email,
              isOwner: workspaceMemberships.isOwner,
            })
            .from(workspaceMemberships)
            .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
            .where(eq(workspaceMemberships.workspaceId, workspaceId))
            .orderBy(workspaceMemberships.createdAt, workspaceMemberships.humanId);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    // Creating a shared workspace and its first owner is one transaction: a workspace
    // can never exist without an owner, and the creator can configure it immediately.
    async create(account, input) {
      const actor = requireAccount(account);
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        await tx.insert(workspaces).values({
          id,
          kind: WorkspaceKind.enum.shared,
          name: input.name,
        });
        await tx.insert(workspaceMemberships).values({
          id: randomUUID(),
          workspaceId: id,
          humanId: actor.humanId,
          isOwner: true,
        });
        await recordEvent(tx, "workspace_created", id, actor.humanId, actor.humanId);
      });
      return { id, kind: WorkspaceKind.enum.shared, name: input.name, isOwner: true };
    },

    // An owner invites one address. The invitation can go to an existing account or an
    // address with no account yet; the email does not reveal which. The inviter must be
    // verified (a new-email invitation creates the account, #20) and still an owner at
    // acceptance, which is rechecked there.
    async invite(account, workspaceId, input) {
      const actor = requireAccount(account);
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      let workspaceName: string;
      try {
        workspaceName = await db.transaction(async (tx) => {
          const workspace = await lockWorkspaceForMutation(tx, workspaceId);
          await requireOwner(tx, workspaceId, actor.humanId);

          const [inviter] = await tx
            .select({ emailVerifiedAt: humans.emailVerifiedAt })
            .from(humans)
            .where(eq(humans.id, actor.humanId))
            .limit(1);
          // Accounts stay active until #38 introduces deactivation; until then an
          // existing account is active by definition. Verification is already concrete.
          if (inviter === undefined || inviter.emailVerifiedAt === null) {
            throw new WorkspacesError("inviter_unverified");
          }

          const [member] = await tx
            .select({ id: workspaceMemberships.id })
            .from(workspaceMemberships)
            .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
            .where(
              and(eq(workspaceMemberships.workspaceId, workspaceId), eq(humans.email, input.email)),
            )
            .limit(1);
          if (member !== undefined) throw new WorkspacesError("already_member");

          // A pending invitation blocks a new one for its full seven days, whatever the
          // email delivery recorded. Delivery is a separate fact (#20): a failed or
          // unconfirmed send does not shorten the invitation's life. Replacement here is
          // only the in-place expiry of a row whose deadline has actually passed; full
          // resend/revoke management remains #25.
          const [blocking] = await tx
            .select({ id: workspaceInvitations.id })
            .from(workspaceInvitations)
            .where(
              and(
                eq(workspaceInvitations.workspaceId, workspaceId),
                eq(workspaceInvitations.email, input.email),
                eq(workspaceInvitations.status, InvitationStatus.enum.pending),
                gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
              ),
            )
            .limit(1);
          if (blocking !== undefined) throw new WorkspacesError("invitation_pending");

          await tx
            .update(workspaceInvitations)
            .set({ status: InvitationStatus.enum.expired })
            .where(
              and(
                eq(workspaceInvitations.workspaceId, workspaceId),
                eq(workspaceInvitations.email, input.email),
                eq(workspaceInvitations.status, InvitationStatus.enum.pending),
                lte(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
              ),
            );

          await tx.insert(workspaceInvitations).values({
            id,
            workspaceId,
            email: input.email,
            status: InvitationStatus.enum.pending,
            tokenHash: tokenHash(token),
            invitedByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          });
          // The mail is sent after the insert commits, like the installation invitation:
          // the row is the durable offer, the delivery attempt is separate.
          return workspace.name;
        });
      } catch (error) {
        if (uniqueConstraintName(error) === "one_pending_workspace_invitation_per_email") {
          throw new WorkspacesError("invitation_pending");
        }
        throw error;
      }

      try {
        await deliver(invitationMail(workspaceName, input.email, token, publicUrl));
      } catch (error) {
        try {
          await recordDelivery(db, id, InvitationDelivery.enum.failed);
        } catch (recordingError) {
          log?.warn(
            "failed workspace invitation delivery recording failed",
            errorNameAndCode(recordingError),
          );
        }
        throw error;
      }
      await recordDelivery(db, id, InvitationDelivery.enum.sent);
      return { workspaceId, email: input.email, status: InvitationStatus.enum.pending };
    },

    // The link's read side: the workspace and address the link offers, without consuming
    // the token. Invalid, expired, used, or known-failed links answer the same Problem.
    async previewInvitation(token) {
      const [row] = await db
        .select({
          workspaceId: workspaceInvitations.workspaceId,
          workspaceName: workspaces.name,
          email: workspaceInvitations.email,
        })
        .from(workspaceInvitations)
        .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
        .where(
          and(
            eq(workspaceInvitations.tokenHash, tokenHash(token)),
            eq(workspaceInvitations.status, InvitationStatus.enum.pending),
            gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
            sql`${workspaceInvitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
          ),
        )
        .limit(1);
      if (row === undefined) throw new WorkspacesError("invitation_invalid");
      return row;
    },

    // The workspace is locked, then the token is consumed by one shared transition
    // helper. The account and the offered access are rechecked inside the same
    // transaction; a mismatch or a lost inviter authority rolls the token back to
    // pending rather than burning it.
    async acceptInvitation(account, token) {
      const actor = requireAccount(account);
      const workspace = await db.transaction(async (tx) => {
        const invitation = await redeemWorkspaceInvitation(tx, token);

        // The account's current email and verification state, read in this transaction:
        // a forwarded link cannot attach to another address, and an unverified account
        // cannot claim an invitation that would otherwise verify it for free.
        const [human] = await tx
          .select({ email: humans.email, emailVerifiedAt: humans.emailVerifiedAt })
          .from(humans)
          .where(eq(humans.id, actor.humanId))
          .limit(1);
        if (human === undefined) throw new WorkspacesError("not_signed_in");
        if (human.email !== invitation.email) {
          throw new WorkspacesError("invitation_recipient_mismatch");
        }
        if (human.emailVerifiedAt === null) throw new WorkspacesError("email_unverified");

        const inserted = await tx
          .insert(workspaceMemberships)
          .values({
            id: randomUUID(),
            workspaceId: invitation.workspaceId,
            humanId: actor.humanId,
            isOwner: false,
          })
          .onConflictDoNothing()
          .returning({ id: workspaceMemberships.id });
        if (inserted.length === 0) throw new WorkspacesError("already_member");

        await recordEvent(
          tx,
          "member_joined",
          invitation.workspaceId,
          actor.humanId,
          actor.humanId,
        );
        return invitation.workspace;
      });
      return { ...workspace, isOwner: false };
    },

    // A new address: the invitation creates the installation account, its personal
    // workspace, the verified mark, and the membership in one transaction. The shared
    // redemption helper locks the workspace first and rechecks inviter authority; any
    // failure leaves the token pending and no partial account behind.
    async registerThroughInvitation(input) {
      const email = await db.transaction(async (tx) => {
        const invitation = await redeemWorkspaceInvitation(tx, input.token);

        const [existing] = await tx
          .select({ id: humans.id })
          .from(humans)
          .where(eq(humans.email, invitation.email))
          .limit(1);
        if (existing !== undefined) throw new WorkspacesError("account_exists");

        try {
          const { humanId } = await createInvitedHuman(
            { email: invitation.email, password: input.password },
            tx,
          );
          await markEmailVerified(humanId, tx);
          await tx.insert(workspaceMemberships).values({
            id: randomUUID(),
            workspaceId: invitation.workspaceId,
            humanId,
            isOwner: false,
          });
          await recordEvent(tx, "member_joined", invitation.workspaceId, humanId, humanId);
        } catch (error) {
          if (uniqueConstraintName(error) === "humans_email_unique") {
            throw new WorkspacesError("account_exists");
          }
          throw error;
        }
        return invitation.email;
      });
      return { email, emailVerified: true as const };
    },

    // Owners appoint existing members. The workspace lock serializes appointments with
    // removals, and an already-owner member is a no-op rather than a duplicate event.
    async appointOwner(account, workspaceId, humanId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockWorkspaceForMutation(tx, workspaceId);
        await requireOwner(tx, workspaceId, actor.humanId);

        const [member] = await tx
          .select({
            humanId: workspaceMemberships.humanId,
            email: humans.email,
            isOwner: workspaceMemberships.isOwner,
          })
          .from(workspaceMemberships)
          .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.humanId, humanId),
            ),
          )
          .limit(1);
        if (member === undefined) throw new WorkspacesError("member_not_found");
        if (member.isOwner) return member;

        await tx
          .update(workspaceMemberships)
          .set({ isOwner: true })
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.humanId, humanId),
            ),
          );
        await recordEvent(tx, "owner_appointed", workspaceId, actor.humanId, humanId);
        return { ...member, isOwner: true };
      });
    },

    // Removing a membership, owner or not. Owners are counted after the workspace lock,
    // so two racing removals cannot both conclude that another owner remains. The
    // database trigger from the migration is the second line of defence.
    async removeMember(account, workspaceId, humanId) {
      const actor = requireAccount(account);
      await db.transaction(async (tx) => {
        await lockWorkspaceForMutation(tx, workspaceId);
        await requireOwner(tx, workspaceId, actor.humanId);

        const [target] = await tx
          .select({ isOwner: workspaceMemberships.isOwner })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.humanId, humanId),
            ),
          )
          .limit(1);
        if (target === undefined) throw new WorkspacesError("member_not_found");

        if (target.isOwner) {
          const [owners] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.workspaceId, workspaceId),
                eq(workspaceMemberships.isOwner, true),
              ),
            );
          if ((owners?.count ?? 0) <= 1) throw new WorkspacesError("last_owner");
        }

        await tx
          .delete(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.humanId, humanId),
            ),
          );
        await recordEvent(
          tx,
          target.isOwner ? "owner_removed" : "member_removed",
          workspaceId,
          actor.humanId,
          humanId,
        );
      });
    },
  };
}
