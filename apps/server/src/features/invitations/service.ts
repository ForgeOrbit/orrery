import { createHash, randomBytes, randomUUID } from "node:crypto";
import { InvitationStatus } from "@orrery/contract";
import type { InstallationInvitation } from "@orrery/contract";
import { and, eq, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode, uniqueConstraintName } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import type { SessionAccount } from "../accounts/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import { humans, invitations } from "../../db/schema.ts";

// The service is the only file in a feature that decides anything. rest.ts calls it.

// How long an invitation lives (#20): seven days, evaluated in database time at
// redemption, never by a deployed clock.
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

// The emailed link carries a random token; only its SHA-256 is stored, exactly like
// accounts' session tokens and settings' verification tokens.
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

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
function requireAdministrator(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new InvitationsError("not_signed_in");
  if (!account.isSystemAdministrator) throw new InvitationsError("not_admin");
  return account;
}

export interface InvitationsServiceDeps {
  db: PostgresJsDatabase;
  // The URL the emailed link carries.
  publicUrl: string;
  // Accounts owns humans and personal workspaces: it creates the invited human inside
  // the redemption transaction, and the verified mark is applied through it too.
  createInvitedHuman: (
    input: { email: string; password: string },
    tx: DbTransaction,
  ) => Promise<{ humanId: string }>;
  markEmailVerified: (humanId: string, tx: DbTransaction) => Promise<void>;
  // The one mail path: settings' exported sender, never a second transport.
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
  createInvitedHuman,
  markEmailVerified,
  deliver,
  log,
}: InvitationsServiceDeps): InvitationsService {
  return {
    // Sends the invitation: one pending row per email, then the email through settings'
    // sender. A send that fails leaves no live invitation behind, so a link that was
    // never delivered cannot redeem, and the administrator can simply invite again.
    async inviteInstallation(account, input) {
      const admin = requireAdministrator(account);
      // A registered address has nothing to be invited to.
      const registered = await db
        .select({ id: humans.id })
        .from(humans)
        .where(eq(humans.email, input.email))
        .limit(1);
      if (registered.length > 0) throw new InvitationsError("account_exists");

      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      try {
        await db.insert(invitations).values({
          id,
          email: input.email,
          status: InvitationStatus.enum.pending,
          tokenHash: tokenHash(token),
          invitedByHumanId: admin.humanId,
          expiresAt: sql`now() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
        });
      } catch (error) {
        // One pending invitation per email: the loser of a race learns the same as the
        // loser of a double click.
        if (uniqueConstraintName(error) === "one_pending_invitation_per_email") {
          throw new InvitationsError("invitation_pending");
        }
        throw error;
      }

      try {
        await deliver(invitationMail(input.email, token, publicUrl));
      } catch (error) {
        // The email never left, so its link must not redeem. The delivery Problem
        // (settings' code, already logged there) still goes out; if even the cleanup
        // fails, the log keeps its name and code only, never its message.
        try {
          await db.delete(invitations).where(eq(invitations.id, id));
        } catch (cleanupError) {
          log?.warn(
            "invitation cleanup after a failed delivery failed",
            errorNameAndCode(cleanupError),
          );
        }
        throw error;
      }
      return { email: input.email, status: InvitationStatus.enum.pending };
    },

    // One conditional update, evaluated in database time: the invitation must be pending
    // and unexpired, and only this POST consumes its token. The account, its personal
    // workspace, and the verified mark join the same transaction, so a half-registered
    // human cannot exist, and a reused or expired link changes nothing.
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
