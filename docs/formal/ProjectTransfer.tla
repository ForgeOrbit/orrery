--------------------------- MODULE ProjectTransfer ---------------------------
(***************************************************************************)
(* Formal TLA+ specification of Orrery's Project Transfer Authorization    *)
(* state machine coupled with Project ownership, Work Sessions, and Inbox  *)
(* Questions (#39).                                                        *)
(*                                                                         *)
(* Models:                                                                 *)
(*   - TransferAuthorization: pending | accepted | revoked | expired       *)
(*     with DB-time expiry; up to 2 rival authorizations for 2 shared      *)
(*     destinations.                                                       *)
(*   - Project: workspaceId in {personal, shared1, shared2}.               *)
(*   - WorkSession: active (live/lapsed) or none/expired.                  *)
(*   - Question: workspaceId in {personal, shared1, shared2},              *)
(*     status in {none, open, paused, answered}.                           *)
(*                                                                         *)
(* Key invariants verified by TLC:                                         *)
(*   1. TypeOK                                                             *)
(*   2. AtMostOneAccepted: at most one transfer authorization is accepted. *)
(*   3. AcceptedImpliesMovedAndRivalsRevoked: if an authorization is       *)
(*      accepted, the project is in its destination workspace and every    *)
(*      other authorization is revoked (never still pending).              *)
(*   4. QuestionWorkspaceMatchesProject: whenever a question exists on the *)
(*      project, its workspaceId equals the project's current workspaceId  *)
(*      (catches Bug #3 where transfers left questions.workspaceId stale!).*)
(*   5. NoLiveSessionInWrongWorkspace: no live active session belongs to   *)
(*      a workspace different from the project's current workspace.        *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Destinations

VARIABLES
  projectWorkspace,     \* "personal" \cup Destinations
  authStatus,           \* [Destinations -> {"none", "pending", "accepted", "revoked", "expired"}]
  authExpired,          \* [Destinations -> BOOLEAN]
  destAuthority,        \* [Destinations -> BOOLEAN]
  sourceAuthority,      \* BOOLEAN

  sessionStatus,        \* "none" | "active" | "expired"
  sessionWorkspace,     \* "none" | "personal" | Destinations
  leaseLapsed,          \* BOOLEAN

  questionStatus,       \* "none" | "open" | "paused" | "answered"
  questionWorkspace     \* "none" | "personal" | Destinations

vars == <<
  projectWorkspace, authStatus, authExpired, destAuthority, sourceAuthority,
  sessionStatus, sessionWorkspace, leaseLapsed,
  questionStatus, questionWorkspace
>>

AllWorkspaces == {"personal"} \cup Destinations

TransferTransitions(s) ==
  CASE s = "none"     -> {"pending"}
    [] s = "pending"  -> {"accepted", "revoked", "expired"}
    [] s = "accepted" -> {}
    [] s = "revoked"  -> {}
    [] s = "expired"  -> {}

Init ==
  /\ projectWorkspace = "personal"
  /\ authStatus = [d \in Destinations |-> "none"]
  /\ authExpired = [d \in Destinations |-> FALSE]
  /\ destAuthority = [d \in Destinations |-> TRUE]
  /\ sourceAuthority = TRUE
  /\ sessionStatus = "none"
  /\ sessionWorkspace = "none"
  /\ leaseLapsed = FALSE
  /\ questionStatus = "none"
  /\ questionWorkspace = "none"

(* Source owner authorizes transfer to destination d *)
Authorize(d) ==
  /\ projectWorkspace = "personal"
  /\ sourceAuthority
  /\ authStatus[d] = "none"
  /\ authStatus' = [authStatus EXCEPT ![d] = "pending"]
  /\ authExpired' = [authExpired EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<projectWorkspace, destAuthority, sourceAuthority,
                 sessionStatus, sessionWorkspace, leaseLapsed,
                 questionStatus, questionWorkspace>>

(* DB-time expiry of authorization d *)
ExpireAuth(d) ==
  /\ authStatus[d] = "pending"
  /\ ~authExpired[d]
  /\ authExpired' = [authExpired EXCEPT ![d] = TRUE]
  /\ UNCHANGED <<projectWorkspace, authStatus, destAuthority, sourceAuthority,
                 sessionStatus, sessionWorkspace, leaseLapsed,
                 questionStatus, questionWorkspace>>

(* Destination authority lost/regained *)
ToggleDestAuthority(d) ==
  /\ destAuthority' = [destAuthority EXCEPT ![d] = ~destAuthority[d]]
  /\ UNCHANGED <<projectWorkspace, authStatus, authExpired, sourceAuthority,
                 sessionStatus, sessionWorkspace, leaseLapsed,
                 questionStatus, questionWorkspace>>

(* Agent claims the issue in the project's current workspace *)
ClaimWork ==
  /\ sessionStatus /= "active"
  /\ questionStatus \notin {"open", "paused"}
  /\ sessionStatus' = "active"
  /\ sessionWorkspace' = projectWorkspace
  /\ leaseLapsed' = FALSE
  /\ UNCHANGED <<projectWorkspace, authStatus, authExpired, destAuthority,
                 sourceAuthority, questionStatus, questionWorkspace>>

(* Session lease lapses in DB time *)
LeaseLapses ==
  /\ sessionStatus = "active"
  /\ ~leaseLapsed
  /\ leaseLapsed' = TRUE
  /\ UNCHANGED <<projectWorkspace, authStatus, authExpired, destAuthority,
                 sourceAuthority, sessionStatus, sessionWorkspace,
                 questionStatus, questionWorkspace>>

(* Agent asks a question while holding a live session *)
AskQuestion ==
  /\ sessionStatus = "active"
  /\ ~leaseLapsed
  /\ questionStatus \notin {"open", "paused"}
  /\ questionStatus' = "open"
  /\ questionWorkspace' = projectWorkspace
  /\ UNCHANGED <<projectWorkspace, authStatus, authExpired, destAuthority,
                 sourceAuthority, sessionStatus, sessionWorkspace, leaseLapsed>>

(* Question pauses at 1h deadline *)
PauseQuestion ==
  /\ questionStatus = "open"
  /\ questionStatus' = "paused"
  /\ sessionStatus' = IF sessionStatus = "active" /\ ~leaseLapsed THEN "none"
                      ELSE IF sessionStatus = "active" /\ leaseLapsed THEN "expired"
                      ELSE sessionStatus
  /\ UNCHANGED <<projectWorkspace, authStatus, authExpired, destAuthority,
                 sourceAuthority, sessionWorkspace, leaseLapsed,
                 questionWorkspace>>

(* Single-transaction transfer acceptance:
   - Rechecks pending & unexpired, source authority, dest authority, project still in personal,
     and no live work session.
   - Materializes lapsed sessions as 'expired'.
   - Updates projects.workspaceId AND questions.workspaceId to d!
   - Marks auth[d] = 'accepted' and revokes all rival pending authorizations. *)
AcceptTransfer(d) ==
  /\ authStatus[d] = "pending"
  /\ ~authExpired[d]
  /\ sourceAuthority
  /\ destAuthority[d]
  /\ projectWorkspace = "personal"
  /\ ~(sessionStatus = "active" /\ ~leaseLapsed)
  /\ "accepted" \in TransferTransitions(authStatus[d])
  /\ projectWorkspace' = d
  /\ sessionStatus' = IF sessionStatus = "active" /\ leaseLapsed THEN "expired" ELSE sessionStatus
  /\ questionWorkspace' = IF questionStatus /= "none" THEN d ELSE questionWorkspace
  /\ authStatus' = [x \in Destinations |->
       IF x = d THEN "accepted"
       ELSE IF authStatus[x] = "pending" THEN "revoked"
       ELSE authStatus[x]]
  /\ UNCHANGED <<authExpired, destAuthority, sourceAuthority,
                 sessionWorkspace, leaseLapsed, questionStatus>>

Next ==
  \/ ClaimWork
  \/ LeaseLapses
  \/ AskQuestion
  \/ PauseQuestion
  \/ \E d \in Destinations:
       \/ Authorize(d)
       \/ ExpireAuth(d)
       \/ ToggleDestAuthority(d)
       \/ AcceptTransfer(d)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ projectWorkspace \in AllWorkspaces
  /\ authStatus \in [Destinations -> {"none", "pending", "accepted", "revoked", "expired"}]
  /\ authExpired \in [Destinations -> BOOLEAN]
  /\ destAuthority \in [Destinations -> BOOLEAN]
  /\ sourceAuthority \in BOOLEAN
  /\ sessionStatus \in {"none", "active", "expired"}
  /\ sessionWorkspace \in ({"none"} \cup AllWorkspaces)
  /\ leaseLapsed \in BOOLEAN
  /\ questionStatus \in {"none", "open", "paused", "answered"}
  /\ questionWorkspace \in ({"none"} \cup AllWorkspaces)

AtMostOneAccepted ==
  Cardinality({d \in Destinations : authStatus[d] = "accepted"}) <= 1

AcceptedImpliesMovedAndRivalsRevoked ==
  \A d \in Destinations:
    authStatus[d] = "accepted" =>
      /\ projectWorkspace = d
      /\ \A r \in Destinations \ {d}: authStatus[r] /= "pending"

QuestionWorkspaceMatchesProject ==
  questionStatus /= "none" => questionWorkspace = projectWorkspace

NoLiveSessionInWrongWorkspace ==
  (sessionStatus = "active" /\ ~leaseLapsed) => sessionWorkspace = projectWorkspace

=============================================================================
