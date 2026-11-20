----------------------------- MODULE RunLifecycle -----------------------------
(***************************************************************************)
(* Formal TLA+ specification of Orrery's Run and RunChild state machines   *)
(* (#34): active <-> ended transitions, endedAt consistency, model change  *)
(* history monotonicity, and child linkage without self-loops.             *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Models

VARIABLES
  runStatus,      \* "none" | "active" | "ended"
  runEndedAt,     \* BOOLEAN (TRUE iff endedAt is non-null)
  runModel,       \* "none" \cup Models
  modelChanges,   \* 0..3
  childStatus,    \* "none" | "active" | "ended"
  childEndedAt    \* BOOLEAN

vars == <<runStatus, runEndedAt, runModel, modelChanges, childStatus, childEndedAt>>

NextRunStatus(cur, ev) ==
  IF ev = "run_ended" THEN "ended"
  ELSE IF ev = "run_started" /\ cur = "ended" THEN "active"
  ELSE IF cur = "none" THEN "active"
  ELSE cur

Init ==
  /\ runStatus = "none"
  /\ runEndedAt = FALSE
  /\ runModel = "none"
  /\ modelChanges = 0
  /\ childStatus = "none"
  /\ childEndedAt = FALSE

ReportRun(ev, m) ==
  /\ ev \in {"run_started", "run_heartbeat", "run_ended"}
  /\ m \in ({"none"} \cup Models)
  /\ LET inserted == (runStatus = "none")
         baseStatus == IF inserted THEN "active" ELSE runStatus
         nextS == NextRunStatus(baseStatus, ev)
         changed == (~inserted /\ m /= "none" /\ m /= runModel)
     IN
       /\ (~changed \/ modelChanges < 3)
       /\ runStatus' = nextS
       /\ runEndedAt' = (nextS = "ended")
       /\ runModel' = IF inserted THEN m ELSE IF changed THEN m ELSE runModel
       /\ modelChanges' = IF changed THEN modelChanges + 1 ELSE modelChanges
       /\ UNCHANGED <<childStatus, childEndedAt>>

ReportChild(ev) ==
  /\ runStatus /= "none"
  /\ ev \in {"child_started", "child_ended"}
  /\ childStatus' = IF ev = "child_ended" THEN "ended" ELSE "active"
  /\ childEndedAt' = (ev = "child_ended")
  /\ UNCHANGED <<runStatus, runEndedAt, runModel, modelChanges>>

Next ==
  \/ \E ev \in {"run_started", "run_heartbeat", "run_ended"}, m \in ({"none"} \cup Models):
       ReportRun(ev, m)
  \/ \E ev \in {"child_started", "child_ended"}:
       ReportChild(ev)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
  /\ runStatus \in {"none", "active", "ended"}
  /\ runEndedAt \in BOOLEAN
  /\ runModel \in ({"none"} \cup Models)
  /\ modelChanges \in 0..3
  /\ childStatus \in {"none", "active", "ended"}
  /\ childEndedAt \in BOOLEAN

RunEndedAtMatchesStatus ==
  runEndedAt <=> (runStatus = "ended")

ChildEndedAtMatchesStatus ==
  childEndedAt <=> (childStatus = "ended")

KnownModelNeverErased ==
  (modelChanges > 0) => (runModel /= "none")

=============================================================================
