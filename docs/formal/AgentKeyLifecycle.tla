-------------------------- MODULE AgentKeyLifecycle --------------------------
(***************************************************************************)
(* Formal TLA+ specification of Orrery's Agent API Key state machine       *)
(* (active | expired | revoked) with rotation overlap, Never validity,     *)
(* idempotent revocation events, and workspace member removal (#30, #35).  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Keys

VARIABLES
  exists,         \* [Keys -> BOOLEAN]
  validity,       \* [Keys -> {"finite", "never"}]
  expired,        \* [Keys -> BOOLEAN]
  revoked,        \* [Keys -> BOOLEAN]
  replaces,       \* [Keys -> {"none"} \cup Keys]
  revokeEvents,   \* [Keys -> 0..2]
  memberActive    \* BOOLEAN

vars == <<exists, validity, expired, revoked, replaces, revokeEvents, memberActive>>

EffectiveKeyState(k) ==
  IF ~exists[k] THEN "none"
  ELSE IF revoked[k] THEN "revoked"
  ELSE IF validity[k] = "finite" /\ expired[k] THEN "expired"
  ELSE "active"

CanAuthenticate(k) ==
  EffectiveKeyState(k) = "active" /\ memberActive

CanRotate(k) ==
  EffectiveKeyState(k) = "active" /\ memberActive

Init ==
  /\ exists = [k \in Keys |-> FALSE]
  /\ validity = [k \in Keys |-> "finite"]
  /\ expired = [k \in Keys |-> FALSE]
  /\ revoked = [k \in Keys |-> FALSE]
  /\ replaces = [k \in Keys |-> "none"]
  /\ revokeEvents = [k \in Keys |-> 0]
  /\ memberActive = TRUE

IssueKey(k, val) ==
  /\ val \in {"finite", "never"}
  /\ memberActive
  /\ ~exists[k]
  /\ exists' = [exists EXCEPT ![k] = TRUE]
  /\ validity' = [validity EXCEPT ![k] = val]
  /\ expired' = [expired EXCEPT ![k] = FALSE]
  /\ revoked' = [revoked EXCEPT ![k] = FALSE]
  /\ replaces' = [replaces EXCEPT ![k] = "none"]
  /\ UNCHANGED <<revokeEvents, memberActive>>

RotateKey(src, dst, val) ==
  /\ src /= dst
  /\ val \in {"finite", "never"}
  /\ CanRotate(src)
  /\ ~exists[dst]
  /\ exists' = [exists EXCEPT ![dst] = TRUE]
  /\ validity' = [validity EXCEPT ![dst] = val]
  /\ expired' = [expired EXCEPT ![dst] = FALSE]
  /\ revoked' = [revoked EXCEPT ![dst] = FALSE]
  /\ replaces' = [replaces EXCEPT ![dst] = src]
  /\ UNCHANGED <<revokeEvents, memberActive>>

ExpireKey(k) ==
  /\ exists[k]
  /\ validity[k] = "finite"
  /\ ~expired[k]
  /\ expired' = [expired EXCEPT ![k] = TRUE]
  /\ UNCHANGED <<exists, validity, revoked, replaces, revokeEvents, memberActive>>

(* Idempotent revocation: already-revoked key writes no second event *)
RevokeKey(k) ==
  /\ exists[k]
  /\ IF ~revoked[k] THEN
       /\ revoked' = [revoked EXCEPT ![k] = TRUE]
       /\ revokeEvents' = [revokeEvents EXCEPT ![k] = revokeEvents[k] + 1]
     ELSE
       /\ UNCHANGED <<revoked, revokeEvents>>
  /\ UNCHANGED <<exists, validity, expired, replaces, memberActive>>

(* Member removal revokes all existing non-revoked keys in one transaction *)
RemoveMember ==
  /\ memberActive
  /\ memberActive' = FALSE
  /\ revoked' = [k \in Keys |-> IF exists[k] THEN TRUE ELSE revoked[k]]
  /\ revokeEvents' = [k \in Keys |->
       IF exists[k] /\ ~revoked[k] THEN revokeEvents[k] + 1 ELSE revokeEvents[k]]
  /\ UNCHANGED <<exists, validity, expired, replaces>>

Next ==
  \/ RemoveMember
  \/ \E k \in Keys:
       \/ IssueKey(k, "finite")
       \/ IssueKey(k, "never")
       \/ ExpireKey(k)
       \/ RevokeKey(k)
  \/ \E k1, k2 \in Keys:
       \/ RotateKey(k1, k2, "finite")
       \/ RotateKey(k1, k2, "never")

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ exists \in [Keys -> BOOLEAN]
  /\ validity \in [Keys -> {"finite", "never"}]
  /\ expired \in [Keys -> BOOLEAN]
  /\ revoked \in [Keys -> BOOLEAN]
  /\ replaces \in [Keys -> ({"none"} \cup Keys)]
  /\ revokeEvents \in [Keys -> 0..2]
  /\ memberActive \in BOOLEAN

AtMostOneRevokeEventPerKey ==
  \A k \in Keys: revokeEvents[k] <= 1

NeverKeyNeverExpires ==
  \A k \in Keys: (exists[k] /\ validity[k] = "never") => ~expired[k]

RemovedMemberNoAuth ==
  ~memberActive => \A k \in Keys: ~CanAuthenticate(k) /\ (exists[k] => revoked[k])

RevokedNeverAuthenticates ==
  \A k \in Keys: revoked[k] => ~CanAuthenticate(k)

NoSelfReplacement ==
  \A k \in Keys: replaces[k] /= k

=============================================================================
