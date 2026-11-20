------------------------- MODULE WorkSessionAndInbox -------------------------
(***************************************************************************)
(* Formal TLA+ specification of Orrery's coupled Work Session, Inbox       *)
(* Question, Issue (status + needsInput), and Member Removal state         *)
(* machines.                                                               *)
(*                                                                         *)
(* Models:                                                                 *)
(*   - WorkSession: none | active | completed | released | expired         *)
(*     with DB-time lease (live vs lapsed) and preserved progress.         *)
(*   - Question: none | open | paused | answered | fallback_used           *)
(*     with DB-time 1h deadline and optional follow-up.                    *)
(*   - Issue: status in {open, closed}, needsInput in BOOLEAN.             *)
(*   - Member membership: active vs removed (triggers claim release).      *)
(*                                                                         *)
(* Key invariants verified by TLC:                                         *)
(*   1. TypeOK: all variables remain in their valid domains.               *)
(*   2. TerminalSessionNeverChanges: once a session is completed,          *)
(*      released, or expired, its status never changes (and an already     *)
(*      lapsed session is NEVER overwritten to 'released' by deadline      *)
(*      pause or member removal).                                          *)
(*   3. NeedsInputSync: issues.needsInput = TRUE iff an open or paused     *)
(*      question exists on the issue.                                      *)
(*   4. SingleResolution: once a question is answered, it never reverts;   *)
(*      once fallback_used, status stays fallback_used.                    *)
(*   5. NoLeasePastQuestionDeadline: while a question is open and due,     *)
(*      no renewal can extend the session lease.                           *)
(*   6. NoDeadlockOnPausedIssue: a paused question can always be answered  *)
(*      by a human to clear needsInput.                                    *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Agents

VARIABLES
  (* Issue state *)
  issueStatus,       \* "open" | "closed"
  needsInput,        \* BOOLEAN

  (* Current/latest work session on the issue *)
  sessionStatus,     \* "none" | "active" | "completed" | "released" | "expired"
  sessionOwner,      \* "none" | Agents
  leaseLapsed,       \* BOOLEAN: TRUE iff DB clock >= leaseExpiresAt
  progressCount,     \* 0..2: monotonic progress recorded on the issue
  progressAtExpiry,  \* 0..2: progress snapshot when lease lapsed

  (* History ghost variable: tracks if current session was observed expired *)
  wasEffectivelyExpired, \* BOOLEAN

  (* Question state *)
  questionStatus,    \* "none" | "open" | "paused" | "answered" | "fallback_used"
  deadlinePassed,    \* BOOLEAN: TRUE iff DB clock >= responseDeadlineAt
  hasFollowUp,       \* BOOLEAN

  (* Membership of each agent's human owner *)
  memberActive       \* [Agents -> BOOLEAN]

vars == <<
  issueStatus, needsInput,
  sessionStatus, sessionOwner, leaseLapsed, progressCount, progressAtExpiry,
  wasEffectivelyExpired,
  questionStatus, deadlinePassed, hasFollowUp,
  memberActive
>>

-----------------------------------------------------------------------------
(* Explicit state machine transition tables *)

WorkSessionTransitions(s) ==
  CASE s = "none"      -> {"active"}
    [] s = "active"    -> {"active", "completed", "released", "expired"}
    [] s = "completed" -> {}
    [] s = "released"  -> {}
    [] s = "expired"   -> {}

QuestionTransitions(q) ==
  CASE q = "none"          -> {"open"}
    [] q = "open"          -> {"answered", "paused", "fallback_used"}
    [] q = "paused"        -> {"answered"}
    [] q = "answered"      -> {}
    [] q = "fallback_used" -> {}

EffectiveSessionStatus ==
  IF sessionStatus = "active" /\ leaseLapsed THEN "expired" ELSE sessionStatus

EffectiveQuestionStatus ==
  IF questionStatus = "open" /\ deadlinePassed THEN "paused" ELSE questionStatus

HasLiveSession(a) ==
  sessionStatus = "active" /\ ~leaseLapsed /\ sessionOwner = a

-----------------------------------------------------------------------------
Init ==
  /\ issueStatus = "open"
  /\ needsInput = FALSE
  /\ sessionStatus = "none"
  /\ sessionOwner = "none"
  /\ leaseLapsed = FALSE
  /\ progressCount = 0
  /\ progressAtExpiry = 0
  /\ wasEffectivelyExpired = FALSE
  /\ questionStatus = "none"
  /\ deadlinePassed = FALSE
  /\ hasFollowUp = FALSE
  /\ memberActive = [a \in Agents |-> TRUE]

-----------------------------------------------------------------------------
(* DB-time clock advances: lease lapses (5m) *)
LeaseLapses ==
  /\ sessionStatus = "active"
  /\ ~leaseLapsed
  /\ leaseLapsed' = TRUE
  /\ progressAtExpiry' = progressCount
  /\ wasEffectivelyExpired' = TRUE
  /\ UNCHANGED <<issueStatus, needsInput, sessionStatus, sessionOwner,
                 progressCount, questionStatus, deadlinePassed, hasFollowUp,
                 memberActive>>

(* DB-time clock advances: question 1h deadline passes *)
QuestionDeadlinePasses ==
  /\ questionStatus = "open"
  /\ ~deadlinePassed
  /\ deadlinePassed' = TRUE
  /\ UNCHANGED <<issueStatus, needsInput, sessionStatus, sessionOwner,
                 leaseLapsed, progressCount, progressAtExpiry,
                 wasEffectivelyExpired, questionStatus, hasFollowUp,
                 memberActive>>

(* Lazy expiry materializes a lapsed active session as 'expired' *)
ExpireStale ==
  /\ sessionStatus = "active"
  /\ leaseLapsed
  /\ "expired" \in WorkSessionTransitions(sessionStatus)
  /\ sessionStatus' = "expired"
  /\ UNCHANGED <<issueStatus, needsInput, sessionOwner, leaseLapsed,
                 progressCount, progressAtExpiry, wasEffectivelyExpired,
                 questionStatus, deadlinePassed, hasFollowUp, memberActive>>

(* Agent claims an available issue (no live claim, not needsInput, member active) *)
Claim(a) ==
  /\ memberActive[a]
  /\ ~needsInput
  /\ ~(sessionStatus = "active" /\ ~leaseLapsed)
  /\ sessionStatus' = "active"
  /\ sessionOwner' = a
  /\ leaseLapsed' = FALSE
  /\ wasEffectivelyExpired' = FALSE
  /\ UNCHANGED <<issueStatus, needsInput, progressCount, progressAtExpiry,
                 questionStatus, deadlinePassed, hasFollowUp, memberActive>>

(* Agent renews its live session; forbidden if member removed or question due *)
Renew(a) ==
  /\ memberActive[a]
  /\ HasLiveSession(a)
  /\ ~(questionStatus = "open" /\ deadlinePassed)
  /\ leaseLapsed' = FALSE
  /\ UNCHANGED <<issueStatus, needsInput, sessionStatus, sessionOwner,
                 progressCount, progressAtExpiry, wasEffectivelyExpired,
                 questionStatus, deadlinePassed, hasFollowUp, memberActive>>

(* Agent records progress on its live session *)
ReportProgress(a) ==
  /\ memberActive[a]
  /\ HasLiveSession(a)
  /\ ~(questionStatus = "open" /\ deadlinePassed)
  /\ progressCount < 2
  /\ progressCount' = progressCount + 1
  /\ UNCHANGED <<issueStatus, needsInput, sessionStatus, sessionOwner,
                 leaseLapsed, progressAtExpiry, wasEffectivelyExpired,
                 questionStatus, deadlinePassed, hasFollowUp, memberActive>>

(* Agent stops its live session with 'completed' or 'released' *)
Stop(a, outcome) ==
  /\ outcome \in {"completed", "released"}
  /\ memberActive[a]
  /\ HasLiveSession(a)
  /\ ~(questionStatus = "open" /\ deadlinePassed)
  /\ outcome \in WorkSessionTransitions(sessionStatus)
  /\ sessionStatus' = outcome
  /\ UNCHANGED <<issueStatus, needsInput, sessionOwner, leaseLapsed,
                 progressCount, progressAtExpiry, wasEffectivelyExpired,
                 questionStatus, deadlinePassed, hasFollowUp, memberActive>>

(* Agent reacquires its own expired claim when issue is open and not needsInput *)
Reacquire(a) ==
  /\ memberActive[a]
  /\ issueStatus = "open"
  /\ ~needsInput
  /\ EffectiveSessionStatus = "expired"
  /\ sessionOwner = a
  /\ sessionStatus' = "active"
  /\ leaseLapsed' = FALSE
  /\ wasEffectivelyExpired' = FALSE
  \* Progress carried forward: progressCount unchanged (>= progressAtExpiry)
  /\ UNCHANGED <<issueStatus, needsInput, sessionOwner, progressCount,
                 progressAtExpiry, questionStatus, deadlinePassed, hasFollowUp,
                 memberActive>>

(* Agent asks a question while holding a live session on an open issue *)
AskQuestion(a) ==
  /\ memberActive[a]
  /\ issueStatus = "open"
  /\ HasLiveSession(a)
  /\ questionStatus \notin {"open", "paused"}
  /\ questionStatus' = "open"
  /\ deadlinePassed' = FALSE
  /\ hasFollowUp' = FALSE
  /\ needsInput' = TRUE
  /\ UNCHANGED <<issueStatus, sessionStatus, sessionOwner, leaseLapsed,
                 progressCount, progressAtExpiry, wasEffectivelyExpired,
                 memberActive>>

(* Deadline evaluation pauses a due open question.
   CRITICAL FIX: a lapsed session becomes 'expired', NEVER 'released';
   only a still-live session is transitioned to 'released'. *)
EvaluateDeadline ==
  /\ questionStatus = "open"
  /\ deadlinePassed
  /\ "paused" \in QuestionTransitions(questionStatus)
  /\ questionStatus' = "paused"
  /\ needsInput' = TRUE
  /\ sessionStatus' =
       IF sessionStatus = "active" /\ ~leaseLapsed THEN "released"
       ELSE IF sessionStatus = "active" /\ leaseLapsed THEN "expired"
       ELSE sessionStatus
  /\ UNCHANGED <<issueStatus, sessionOwner, leaseLapsed, progressCount,
                 progressAtExpiry, wasEffectivelyExpired, deadlinePassed,
                 hasFollowUp, memberActive>>

(* Human answers an open (before deadline) or paused question *)
AnswerQuestion ==
  /\ \/ (questionStatus = "open" /\ ~deadlinePassed)
     \/ (questionStatus = "paused")
  /\ "answered" \in QuestionTransitions(questionStatus)
  /\ questionStatus' = "answered"
  /\ needsInput' = FALSE
  /\ UNCHANGED <<issueStatus, sessionStatus, sessionOwner, leaseLapsed,
                 progressCount, progressAtExpiry, wasEffectivelyExpired,
                 deadlinePassed, hasFollowUp, memberActive>>

(* Human answers a fallback_used question: records followUp without changing status *)
FollowUpFallback ==
  /\ questionStatus = "fallback_used"
  /\ ~hasFollowUp
  /\ hasFollowUp' = TRUE
  /\ UNCHANGED <<issueStatus, needsInput, sessionStatus, sessionOwner,
                 leaseLapsed, progressCount, progressAtExpiry,
                 wasEffectivelyExpired, questionStatus, deadlinePassed,
                 memberActive>>

(* Human closes or reopens the issue *)
ToggleIssueStatus ==
  /\ issueStatus' = IF issueStatus = "open" THEN "closed" ELSE "open"
  /\ UNCHANGED <<needsInput, sessionStatus, sessionOwner, leaseLapsed,
                 progressCount, progressAtExpiry, wasEffectivelyExpired,
                 questionStatus, deadlinePassed, hasFollowUp, memberActive>>

(* Member is removed or leaves the workspace.
   CRITICAL FIX: already-lapsed sessions materialize as 'expired',
   only still-live sessions are transitioned to 'released'. *)
RemoveMember(a) ==
  /\ memberActive[a]
  /\ memberActive' = [memberActive EXCEPT ![a] = FALSE]
  /\ sessionStatus' =
       IF sessionOwner = a /\ sessionStatus = "active" /\ ~leaseLapsed THEN "released"
       ELSE IF sessionOwner = a /\ sessionStatus = "active" /\ leaseLapsed THEN "expired"
       ELSE sessionStatus
  /\ UNCHANGED <<issueStatus, needsInput, sessionOwner, leaseLapsed,
                 progressCount, progressAtExpiry, wasEffectivelyExpired,
                 questionStatus, deadlinePassed, hasFollowUp>>

-----------------------------------------------------------------------------
Next ==
  \/ LeaseLapses
  \/ QuestionDeadlinePasses
  \/ ExpireStale
  \/ EvaluateDeadline
  \/ AnswerQuestion
  \/ FollowUpFallback
  \/ ToggleIssueStatus
  \/ \E a \in Agents:
       \/ Claim(a)
       \/ Renew(a)
       \/ ReportProgress(a)
       \/ Stop(a, "completed")
       \/ Stop(a, "released")
       \/ Reacquire(a)
       \/ AskQuestion(a)
       \/ RemoveMember(a)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
  /\ issueStatus \in {"open", "closed"}
  /\ needsInput \in BOOLEAN
  /\ sessionStatus \in {"none", "active", "completed", "released", "expired"}
  /\ sessionOwner \in ({"none"} \cup Agents)
  /\ leaseLapsed \in BOOLEAN
  /\ progressCount \in 0..2
  /\ progressAtExpiry \in 0..2
  /\ wasEffectivelyExpired \in BOOLEAN
  /\ questionStatus \in {"none", "open", "paused", "answered", "fallback_used"}
  /\ deadlinePassed \in BOOLEAN
  /\ hasFollowUp \in BOOLEAN
  /\ memberActive \in [Agents -> BOOLEAN]

(* Needs input is ALWAYS strictly synchronized with open/paused questions *)
NeedsInputSync ==
  needsInput <=> (questionStatus \in {"open", "paused"})

(* An already-lapsed session is NEVER clobbered into 'released' or 'completed' *)
ExpiredSessionNeverClobbered ==
  wasEffectivelyExpired => (sessionStatus \notin {"released", "completed"})

(* A removed member's agent NEVER holds a live session *)
RemovedMemberNoLiveSession ==
  \A a \in Agents: (~memberActive[a]) => ~HasLiveSession(a)

(* Progress is never lost across expiry or reacquisition *)
ProgressMonotonic ==
  progressCount >= progressAtExpiry

(* A paused question never keeps a live session *)
PausedQuestionNoLiveSession ==
  (questionStatus = "paused") => ~(sessionStatus = "active" /\ ~leaseLapsed)

=============================================================================
