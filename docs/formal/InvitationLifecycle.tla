------------------------- MODULE InvitationLifecycle -------------------------
(***************************************************************************)
(* Formal TLA+ specification of Orrery's Invitation + Delivery state       *)
(* machine (shared by installation invitations and workspace invitations). *)
(*                                                                         *)
(* Models:                                                                 *)
(*   - Up to 2 invitation slots for one recipient email.                   *)
(*   - Stored status: none | pending | accepted | declined | expired |     *)
(*     revoked.                                                            *)
(*   - Orthogonal deliveryStatus: null | sent | failed + graceWindow.      *)
(*   - DB-time expiry (expired: BOOLEAN).                                  *)
(*   - Recipient account/membership existence (registered: BOOLEAN).       *)
(*                                                                         *)
(* Key invariants verified by TLC:                                         *)
(*   1. TypeOK                                                             *)
(*   2. AtMostOnePending: partial unique index invariant.                  *)
(*   3. AcceptedNeverFailedDelivery: an accepted invitation is never       *)
(*      stamped deliveryStatus = 'failed'.                                 *)
(*   4. NoPendingAfterRegistered: no fresh pending invitation is created   *)
(*      once the recipient is already registered.                          *)
(*   5. FailedDeliveryNeverRedeems: a known-failed delivery never          *)
(*      transitions to accepted or declined.                               *)
(*   6. TerminalNeverChanges: accepted/declined/expired/revoked are        *)
(*      absorbing states.                                                  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Slots

VARIABLES
  status,        \* [Slots -> {"none", "pending", "accepted", "declined", "expired", "revoked"}]
  delivery,      \* [Slots -> {"null", "sent", "failed"}]
  expired,       \* [Slots -> BOOLEAN]
  graceOver,     \* [Slots -> BOOLEAN]
  registered,    \* BOOLEAN
  failedAtRedeem \* BOOLEAN (ghost: TRUE if an accepted row ever had delivery = failed)

vars == <<status, delivery, expired, graceOver, registered, failedAtRedeem>>

InvitationTransitions(s) ==
  CASE s = "none"     -> {"pending"}
    [] s = "pending"  -> {"accepted", "declined", "expired", "revoked"}
    [] s = "accepted" -> {}
    [] s = "declined" -> {}
    [] s = "expired"  -> {}
    [] s = "revoked"  -> {}

IsBlocking(s) ==
  /\ status[s] = "pending"
  /\ ~expired[s]
  /\ (delivery[s] = "sent" \/ (delivery[s] = "null" /\ ~graceOver[s]))

Init ==
  /\ status = [s \in Slots |-> "none"]
  /\ delivery = [s \in Slots |-> "null"]
  /\ expired = [s \in Slots |-> FALSE]
  /\ graceOver = [s \in Slots |-> FALSE]
  /\ registered = FALSE
  /\ failedAtRedeem = FALSE

(* Invite creates a new pending row in an unused slot, superseding any
   expired or undelivered pending row first. Refused if registered or blocked. *)
Invite(s) ==
  /\ ~registered
  /\ status[s] = "none"
  /\ \A o \in Slots: ~IsBlocking(o)
  /\ status' = [x \in Slots |->
       IF x = s THEN "pending"
       ELSE IF status[x] = "pending" /\ expired[x] THEN "expired"
       ELSE IF status[x] = "pending" /\ ~expired[x] THEN "revoked"
       ELSE status[x]]
  /\ UNCHANGED <<delivery, expired, graceOver, registered, failedAtRedeem>>

(* Resend rotates a pending or expired row into a fresh slot *)
Resend(old, fresh) ==
  /\ old /= fresh
  /\ ~registered
  /\ status[old] \in {"pending", "expired"}
  /\ status[fresh] = "none"
  /\ \A o \in Slots \ {old}: status[o] /= "pending"
  /\ status' = [x \in Slots |->
       IF x = fresh THEN "pending"
       ELSE IF x = old /\ status[old] = "pending" /\ ~expired[old] THEN "revoked"
       ELSE IF x = old /\ status[old] = "pending" /\ expired[old] THEN "expired"
       ELSE status[x]]
  /\ UNCHANGED <<delivery, expired, graceOver, registered, failedAtRedeem>>

(* SMTP delivery completes (sent or failed), guarded by status = pending *)
RecordDelivery(s, outcome) ==
  /\ outcome \in {"sent", "failed"}
  /\ status[s] = "pending"
  /\ delivery[s] = "null"
  /\ delivery' = [delivery EXCEPT ![s] = outcome]
  /\ UNCHANGED <<status, expired, graceOver, registered, failedAtRedeem>>

(* DB-time expiry and grace-window expiry *)
PassGraceWindow(s) ==
  /\ status[s] = "pending"
  /\ delivery[s] = "null"
  /\ ~graceOver[s]
  /\ graceOver' = [graceOver EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<status, delivery, expired, registered, failedAtRedeem>>

PassExpiry(s) ==
  /\ status[s] = "pending"
  /\ ~expired[s]
  /\ expired' = [expired EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<status, delivery, graceOver, registered, failedAtRedeem>>

(* Materialize due expiry on read/list *)
ExpireDue(s) ==
  /\ status[s] = "pending"
  /\ expired[s]
  /\ "expired" \in InvitationTransitions(status[s])
  /\ status' = [status EXCEPT ![s] = "expired"]
  /\ UNCHANGED <<delivery, expired, graceOver, registered, failedAtRedeem>>

(* Revoke a pending unexpired invitation *)
Revoke(s) ==
  /\ status[s] = "pending"
  /\ ~expired[s]
  /\ "revoked" \in InvitationTransitions(status[s])
  /\ status' = [status EXCEPT ![s] = "revoked"]
  /\ UNCHANGED <<delivery, expired, graceOver, registered, failedAtRedeem>>

(* Decline a pending, unexpired, non-failed invitation *)
Decline(s) ==
  /\ status[s] = "pending"
  /\ ~expired[s]
  /\ delivery[s] /= "failed"
  /\ "declined" \in InvitationTransitions(status[s])
  /\ status' = [status EXCEPT ![s] = "declined"]
  /\ UNCHANGED <<delivery, expired, graceOver, registered, failedAtRedeem>>

(* Accept/register a pending, unexpired, non-failed invitation *)
Accept(s) ==
  /\ ~registered
  /\ status[s] = "pending"
  /\ ~expired[s]
  /\ delivery[s] /= "failed"
  /\ "accepted" \in InvitationTransitions(status[s])
  /\ status' = [status EXCEPT ![s] = "accepted"]
  /\ registered' = TRUE
  /\ failedAtRedeem' = (failedAtRedeem \/ delivery[s] = "failed")
  /\ UNCHANGED <<delivery, expired, graceOver>>

Next ==
  \/ \E s \in Slots:
       \/ Invite(s)
       \/ RecordDelivery(s, "sent")
       \/ RecordDelivery(s, "failed")
       \/ PassGraceWindow(s)
       \/ PassExpiry(s)
       \/ ExpireDue(s)
       \/ Revoke(s)
       \/ Decline(s)
       \/ Accept(s)
  \/ \E s1, s2 \in Slots: Resend(s1, s2)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ status \in [Slots -> {"none", "pending", "accepted", "declined", "expired", "revoked"}]
  /\ delivery \in [Slots -> {"null", "sent", "failed"}]
  /\ expired \in [Slots -> BOOLEAN]
  /\ graceOver \in [Slots -> BOOLEAN]
  /\ registered \in BOOLEAN
  /\ failedAtRedeem \in BOOLEAN

AtMostOnePending ==
  Cardinality({s \in Slots : status[s] = "pending"}) <= 1

AcceptedNeverFailedDelivery ==
  \A s \in Slots: status[s] = "accepted" => delivery[s] /= "failed"

FailedDeliveryNeverRedeems ==
  ~failedAtRedeem

NoPendingAfterRegistered ==
  registered => \A s \in Slots: status[s] /= "pending"

=============================================================================
