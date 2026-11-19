import { randomBytes, randomUUID } from "node:crypto";
import { InvitationDelivery, InvitationStatus } from "@orrery/contract";
import type { InstallationInvitation, InvitationSummary } from "@orrery/contract";
import { and, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode, uniqueConstraintName } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import type { SessionAccount } from "../accounts/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import { invitations, humans } from "../../db/schema.ts";

// The service is the only file in a feature that decides anything. rest.ts calls it.

// How long an invitation lives (#20): seven days, evaluated in database time at
// redemption, never by a deployed clock.
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

// How long an unknown delivery keeps blocking a fresh invitation. The mail transport
// caps a send well below this (settings' sender: 10s to connect, 10s for the greeting,
// 20s on the socket), so past it the send has finished or died and the row is stale
// rather than in flight. Ten minutes is short next to the seven-day lifetime, so a crash
// cannot block the address for long. Database time only, like every deadline here.
export const UNKNOWN_DELIVERY_GRACE_SECONDS = 10 * 60;

export type InvitationsErrorKind =
  | "not_signed_in"
  | "not_admin"
  | "account_exists"
  | "invitation_pending"
  | "invitation_invalid"
  | "invitation_not_found"
  | "invitation_not_pending"
  | "inviter_not_authorized";

// Each kind is the REST error's stable code and its message the Problem's title
// (ADR-0003), so clients branch on the code and people read the title.
const messages = {
  not_signed_in: "Not signed in.",
  not_admin: "Only a system administrator can manage installation invitations.",
  account_exists: "This email already has an account.",
  invitation_pending: "An invitation for this email is already pending.",
  invitation_invalid: "This invitation is invalid, expired, or already used.",
  invitation_not_found: "This invitation does not exist.",
  invitation_not_pending: "Only a pending or expired invitation can be changed.",
  inviter_not_authorized:
    "The person who sent this invitation is no longer a system administrator.",
} as const satisfies Record<InvitationsErrorKind, string>;

export class InvitationsError extends Error {
  readonly kind: InvitationsErrorKind;

  constructor(kind: InvitationsErrorKind) {
    super(messages[kind]);
    this.name = "InvitationsError";
    this.kind = kind;
  }
}

// The emailed invitation. Plain text like every email the installation sends, with the
// link the recipient follows. The link's GET changes nothing; the password chosen on
// that page is what registers.
function invitationMail(email: string, token: string, publicUrl: string): OutgoingMail {
  return {
    to: email,
    subject: "Your Orrery invitation",
    text: [
      `You have been invited to join this Orrery installation as ${email}.`,
      "",
      "Follow the link and choose a password to register:",
      "",
      `${publicUrl}/register?token=${token}`,
      "",
      "The link is valid for seven days. Opening it changes nothing; choosing a password completes your registration.",
      "",
      "If you did not expect this invitation, ignore it.",
    ].join("\n"),
  };
}

// Installation invitations are administrator-only (issue #23): no session is 401, an
// ordinary account is 403. The one authorization rule of this feature, stated once.
// An unverified administrator may still send: #20's verified-inviter rule is stated for
// workspace invitations, and nothing can be sent at all without configured SMTP, which
// an administrator set up — ADR-0001 signs the first administrator in before
// verification on purpose.
function requireAdministrator(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new InvitationsError("not_signed_in");
  if (!account.isSystemAdministrator) throw new InvitationsError("not_admin");
  return account;
}

// Records one delivery attempt's outcome, separately from the lifecycle (#20): the
// status says whether the email left, the timestamp says when mail was last tried.
async function recordDelivery(db: PostgresJsDatabase, id: string, delivery: InvitationDelivery) {
  await db
    .update(invitations)
    .set({ deliveryStatus: delivery, deliveryAttemptedAt: sql`statement_timestamp()` })
    .where(eq(invitations.id, id));
}

// The deadline is a fact, not a decision. Whenever an inviter looks at invitations or
// changes one, due rows become expired once, at the deadline they already passed. The
// partial index on pending rows is then free for a resend or a fresh invitation.
async function expireDueInstallationInvitations(db: PostgresJsDatabase) {
  await db
    .update(invitations)
    .set({ status: InvitationStatus.enum.expired, expiredAt: invitations.expiresAt })
    .where(
      and(
        eq(invitations.status, InvitationStatus.enum.pending),
        lte(invitations.expiresAt, sql`statement_timestamp()`),
      ),
    );
}

// The projection every management response shares: recipient, inviter, target, offered
// grants, lifecycle timestamps, and delivery as a separate fact. The token never leaves
// the email.
const summarySelection = {
  id: invitations.id,
  email: invitations.email,
  status: invitations.status,
  invitedByHumanId: invitations.invitedByHumanId,
  invitedByEmail: humans.email,
  createdAt: invitations.createdAt,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  declinedAt: invitations.declinedAt,
  expiredAt: invitations.expiredAt,
  revokedAt: invitations.revokedAt,
  deliveryStatus: invitations.deliveryStatus,
  deliveryAttemptedAt: invitations.deliveryAttemptedAt,
} as const;

interface InstallationSummaryRow {
  id: string;
  email: string;
  status: InvitationStatus;
  invitedByHumanId: string;
  invitedByEmail: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  deliveryStatus: InvitationDelivery | null;
  deliveryAttemptedAt: Date | null;
}

function toInstallationSummary(row: InstallationSummaryRow): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    target: { kind: "installation" },
    grants: [{ kind: "installation_account" }],
    invitedBy: { humanId: row.invitedByHumanId, email: row.invitedByEmail },
    delivery: {
      status: row.deliveryStatus,
      attemptedAt: row.deliveryAttemptedAt?.toISOString() ?? null,
    },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    declinedAt: row.declinedAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

async function readInstallationSummary(
  db: PostgresJsDatabase,
  id: string,
): Promise<InvitationSummary> {
  const [row] = await db
    .select(summarySelection)
    .from(invitations)
    .innerJoin(humans, eq(humans.id, invitations.invitedByHumanId))
    .where(eq(invitations.id, id))
    .limit(1);
  if (row === undefined) throw new InvitationsError("invitation_not_found");
  return toInstallationSummary(row);
}

// Sends one installation invitation email and records the attempt separately from the
// lifecycle. A known failure never redeems and answers with settings' own Problem; an
// unknown result is recorded after the send, so the link still redeems if holding it
// proves the email arrived.
async function sendInstallationInvitation(
  db: PostgresJsDatabase,
  deliver: (mail: OutgoingMail) => Promise<void>,
  log: Logger | undefined,
  input: { id: string; email: string; token: string; publicUrl: string },
) {
  try {
    await deliver(invitationMail(input.email, input.token, input.publicUrl));
  } catch (error) {
    try {
      await recordDelivery(db, input.id, InvitationDelivery.enum.failed);
    } catch (recordingError) {
      log?.warn("failed-delivery recording failed", errorNameAndCode(recordingError));
    }
    throw error;
  }
  await recordDelivery(db, input.id, InvitationDelivery.enum.sent);
}

export interface InvitationsServiceDeps {
  db: PostgresJsDatabase;
  // The URL the emailed link carries.
  publicUrl: string;
  // Accounts owns humans: the registered-email guard, the account-creation seam, and
  // the verified mark all live there, and invitations asks instead of querying humans
  // itself.
  emailRegistered: (email: string) => Promise<boolean>;
  createInvitedHuman: (
    input: { email: string; password: string },
    tx: DbTransaction,
  ) => Promise<{ humanId: string }>;
  markEmailVerified: (humanId: string, tx: DbTransaction) => Promise<void>;
  // Settings owns the relay: the one mail path, never a second transport.
  deliver: (mail: OutgoingMail) => Promise<void>;
  log?: Logger;
}

export interface InvitationsService {
  inviteInstallation(
    account: SessionAccount | null,
    input: { email: string },
  ): Promise<InstallationInvitation>;
  listInstallation(account: SessionAccount | null): Promise<InvitationSummary[]>;
  resendInstallation(
    account: SessionAccount | null,
    invitationId: string,
  ): Promise<InvitationSummary>;
  revokeInstallation(
    account: SessionAccount | null,
    invitationId: string,
  ): Promise<InvitationSummary>;
  declineInstallation(input: { token: string }): Promise<void>;
  registerInstallation(input: {
    token: string;
    password: string;
  }): Promise<{ email: string; emailVerified: true }>;
}

export function createInvitationsService({
  db,
  publicUrl,
  emailRegistered,
  createInvitedHuman,
  markEmailVerified,
  deliver,
  log,
}: InvitationsServiceDeps): InvitationsService {
  return {
    // Sends the invitation. No history event here: installation invitations are not
    // among #20's sensitive access actions, and membership events begin with #24's
    // workspace invitations.
    async inviteInstallation(account, input) {
      const admin = requireAdministrator(account);
      // A registered address has nothing to be invited to.
      if (await emailRegistered(input.email)) throw new InvitationsError("account_exists");

      // A pending invitation blocks a new one while it is valid and not known-failed;
      // an expired one, one whose email never left, or one whose delivery stayed unknown
      // past the grace window is superseded in place below. Unknown delivery inside the
      // window blocks too: a send may still be in flight, and silently invalidating a
      // possibly-delivered link is the worse failure. Holding the token redeems either
      // way; only a known failure refuses.
      const blocking = await db
        .select({ id: invitations.id })
        .from(invitations)
        .where(
          and(
            eq(invitations.email, input.email),
            eq(invitations.status, InvitationStatus.enum.pending),
            gt(invitations.expiresAt, sql`now()`),
            or(
              eq(invitations.deliveryStatus, InvitationDelivery.enum.sent),
              and(
                isNull(invitations.deliveryStatus),
                gte(
                  invitations.createdAt,
                  sql`now() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS})`,
                ),
              ),
            ),
          ),
        )
        .limit(1);
      if (blocking.length > 0) throw new InvitationsError("invitation_pending");

      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      try {
        await db.transaction(async (tx) => {
          // Supersede in place: any pending row for this email that is expired,
          // delivery-failed, or left with an unknown delivery past the grace window
          // becomes expired, in the new invitation's own transaction, so the one-pending
          // rule holds for the new link and the old token dies with its row.
          await tx
            .update(invitations)
            .set({
              status: InvitationStatus.enum.expired,
              expiredAt: invitations.expiresAt,
            })
            .where(
              and(
                eq(invitations.email, input.email),
                eq(invitations.status, InvitationStatus.enum.pending),
                or(
                  lte(invitations.expiresAt, sql`now()`),
                  eq(invitations.deliveryStatus, InvitationDelivery.enum.failed),
                  and(
                    isNull(invitations.deliveryStatus),
                    lt(
                      invitations.createdAt,
                      sql`now() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS})`,
                    ),
                  ),
                ),
              ),
            );
          await tx.insert(invitations).values({
            id,
            email: input.email,
            status: InvitationStatus.enum.pending,
            tokenHash: tokenHash(token),
            invitedByHumanId: admin.humanId,
            expiresAt: sql`now() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          });
        });
      } catch (error) {
        // One pending invitation per email: the loser of a race learns the same as the
        // loser of a double click.
        if (uniqueConstraintName(error) === "one_pending_invitation_per_email") {
          throw new InvitationsError("invitation_pending");
        }
        throw error;
      }

      // The delivery attempt, recorded separately from the lifecycle: pending never
      // implies delivered (#20).
      await sendInstallationInvitation(db, deliver, log, {
        id,
        email: input.email,
        token,
        publicUrl,
      });
      return { email: input.email, status: InvitationStatus.enum.pending };
    },

    // Every installation invitation, newest first, with its lifecycle and its delivery
    // as separate facts. Administrators are the only inviters for an installation.
    async listInstallation(account) {
      requireAdministrator(account);
      await expireDueInstallationInvitations(db);
      const rows = await db
        .select(summarySelection)
        .from(invitations)
        .innerJoin(humans, eq(humans.id, invitations.invitedByHumanId))
        .orderBy(desc(invitations.createdAt), desc(invitations.id));
      return rows.map(toInstallationSummary);
    },

    // Resend rotates the link: the old row keeps its history (revoked if still live,
    // otherwise expired), and a new pending row starts a fresh seven-day deadline.
    async resendInstallation(account, invitationId) {
      const admin = requireAdministrator(account);
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      let email: string;
      try {
        email = await db.transaction(async (tx) => {
          const [row] = await tx
            .select({
              id: invitations.id,
              email: invitations.email,
              status: invitations.status,
              live: sql<boolean>`${invitations.expiresAt} > statement_timestamp()`,
            })
            .from(invitations)
            .where(eq(invitations.id, invitationId))
            .for("update");
          if (row === undefined) throw new InvitationsError("invitation_not_found");

          if (row.status === InvitationStatus.enum.pending) {
            await tx
              .update(invitations)
              .set(
                row.live
                  ? {
                      status: InvitationStatus.enum.revoked,
                      revokedAt: sql`statement_timestamp()`,
                    }
                  : {
                      status: InvitationStatus.enum.expired,
                      expiredAt: invitations.expiresAt,
                    },
              )
              .where(eq(invitations.id, invitationId));
          } else if (row.status !== InvitationStatus.enum.expired) {
            throw new InvitationsError("invitation_not_pending");
          }

          await tx.insert(invitations).values({
            id,
            email: row.email,
            status: InvitationStatus.enum.pending,
            tokenHash: tokenHash(token),
            invitedByHumanId: admin.humanId,
            createdAt: sql`statement_timestamp()`,
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          });
          return row.email;
        });
      } catch (error) {
        // A concurrent fresh invitation owns the one pending slot; the resend answers
        // the same as any other pending invitation.
        if (uniqueConstraintName(error) === "one_pending_invitation_per_email") {
          throw new InvitationsError("invitation_pending");
        }
        throw error;
      }

      await sendInstallationInvitation(db, deliver, log, {
        id,
        email,
        token,
        publicUrl,
      });
      return readInstallationSummary(db, id);
    },

    // Revoke is the inviter's answer to an offer that should no longer be live. Only a
    // pending, unexpired row changes: the row keeps who revoked it and when.
    async revokeInstallation(account, invitationId) {
      requireAdministrator(account);
      await expireDueInstallationInvitations(db);
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: invitations.id, status: invitations.status })
          .from(invitations)
          .where(eq(invitations.id, invitationId))
          .for("update");
        if (row === undefined) throw new InvitationsError("invitation_not_found");
        if (row.status !== InvitationStatus.enum.pending) {
          throw new InvitationsError("invitation_not_pending");
        }
        const revoked = await tx
          .update(invitations)
          .set({
            status: InvitationStatus.enum.revoked,
            revokedAt: sql`statement_timestamp()`,
          })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.status, InvitationStatus.enum.pending),
              gt(invitations.expiresAt, sql`statement_timestamp()`),
            ),
          )
          .returning({ id: invitations.id });
        if (revoked.length === 0) throw new InvitationsError("invitation_not_pending");
      });
      return readInstallationSummary(db, invitationId);
    },

    // The recipient declines from the emailed link. Holding the token is the
    // capability; only a pending, unexpired invitation changes, so a forwarded copy
    // cannot disturb an accepted or revoked one.
    async declineInstallation(input) {
      const declined = await db
        .update(invitations)
        .set({
          status: InvitationStatus.enum.declined,
          declinedAt: sql`statement_timestamp()`,
        })
        .where(
          and(
            eq(invitations.tokenHash, tokenHash(input.token)),
            eq(invitations.status, InvitationStatus.enum.pending),
            gt(invitations.expiresAt, sql`statement_timestamp()`),
          ),
        )
        .returning({ id: invitations.id });
      if (declined.length === 0) throw new InvitationsError("invitation_invalid");
    },

    // One conditional update, evaluated in database time: the invitation must be
    // pending, unexpired, and not known-failed, and only this POST consumes its token.
    // An unknown delivery may redeem — holding the token proves the email arrived — so
    // only a recorded failure refuses. The account, its personal workspace, and the
    // verified mark join the same transaction, so a half-registered human cannot exist,
    // and a reused, expired, or failed link changes nothing. No history event here
    // either: the account and its personal workspace are not among #20's sensitive
    // access actions, and membership events begin with #24.
    async registerInstallation(input) {
      const email = await db.transaction(async (tx) => {
        const rows = await tx
          .update(invitations)
          .set({ status: InvitationStatus.enum.accepted, acceptedAt: sql`now()` })
          .where(
            and(
              eq(invitations.tokenHash, tokenHash(input.token)),
              eq(invitations.status, InvitationStatus.enum.pending),
              gt(invitations.expiresAt, sql`now()`),
              sql`${invitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
            ),
          )
          .returning({ email: invitations.email, invitedByHumanId: invitations.invitedByHumanId });
        const [row] = rows;
        if (row === undefined) throw new InvitationsError("invitation_invalid");

        // The offer is still authorized only if its inviter remains a system
        // administrator; the check runs in this transaction, and a failure rolls the
        // token back to pending rather than burning it.
        const [inviter] = await tx
          .select({ isSystemAdministrator: humans.isSystemAdministrator })
          .from(humans)
          .where(eq(humans.id, row.invitedByHumanId))
          .limit(1);
        if (inviter?.isSystemAdministrator !== true) {
          throw new InvitationsError("inviter_not_authorized");
        }

        try {
          const { humanId } = await createInvitedHuman(
            { email: row.email, password: input.password },
            tx,
          );
          await markEmailVerified(humanId, tx);
        } catch (error) {
          // Unreachable while one pending invitation per email holds, but honest if it
          // ever happens: the invited email already has an account, and nothing changes.
          if (uniqueConstraintName(error) === "humans_email_unique") {
            throw new InvitationsError("account_exists");
          }
          throw error;
        }
        return row.email;
      });
      return { email, emailVerified: true as const };
    },
  };
}
