import { randomBytes, randomUUID } from "node:crypto";
import { InvitationDelivery, InvitationStatus } from "@orrery/contract";
import type { InstallationInvitation } from "@orrery/contract";
import { and, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode, uniqueConstraintName } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import type { SessionAccount } from "../accounts/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import { invitations } from "../../db/schema.ts";

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
  | "invitation_invalid";

// Each kind is the REST error's stable code and its message the Problem's title
// (ADR-0003), so clients branch on the code and people read the title.
const messages = {
  not_signed_in: "Not signed in.",
  not_admin: "Only a system administrator can send installation invitations.",
  account_exists: "This email already has an account.",
  invitation_pending: "An invitation for this email is already pending.",
  invitation_invalid: "This invitation is invalid, expired, or already used.",
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
    .set({ deliveryStatus: delivery, deliveryAttemptedAt: sql`now()` })
    .where(eq(invitations.id, id));
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
            .set({ status: InvitationStatus.enum.expired })
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
      try {
        await deliver(invitationMail(input.email, token, publicUrl));
      } catch (error) {
        // The email never left. The invitation stays, with its delivery failure
        // recorded: it can never redeem, and it will not block a fresh invitation.
        // The delivery Problem (settings' code, already logged there) still goes out;
        // if even the recording fails, the log keeps its name and code only, never its
        // message.
        try {
          await recordDelivery(db, id, InvitationDelivery.enum.failed);
        } catch (recordingError) {
          log?.warn("failed-delivery recording failed", errorNameAndCode(recordingError));
        }
        throw error;
      }
      // A delivery that left but could not be recorded answers as an error on purpose:
      // the invitation's delivery stays unknown, so the administrator learns the request
      // failed. The link still redeems, because holding the token proves the email
      // arrived; past the grace window a fresh invitation supersedes the row.
      await recordDelivery(db, id, InvitationDelivery.enum.sent);
      return { email: input.email, status: InvitationStatus.enum.pending };
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
          .returning({ email: invitations.email });
        const [row] = rows;
        if (row === undefined) throw new InvitationsError("invitation_invalid");

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
