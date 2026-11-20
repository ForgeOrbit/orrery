import { z } from "zod";
import {
  CreateIssueCommentRequest,
  CreateIssueLinkRequest,
  CreateIssueRequest,
  CreateKnowledgeEntryRequest,
  Issue,
  IssueComment,
  IssueDependency,
  IssueDetail,
  IssueLink,
  IssuesResponse,
  IssueCommentsResponse,
  KnowledgeEntriesResponse,
  KnowledgeEntry,
  Project,
  ProjectsResponse,
  ProjectActivityResponse,
  UpdateIssueRequest,
  UpdateKnowledgeEntryRequest,
} from "./projects.ts";
import { AskForInputInput, InboxResponse, IssueQuestionParams, QuestionResponse } from "./questions.ts";
import { RunReportInput, RunReportResponse } from "./runs.ts";
import {
  ClaimWorkSessionInput,
  GetWorkSessionInput,
  ListSessionActivitiesInput,
  ListSessionActivitiesResponse,
  LogSessionActivityInput,
  LogSessionActivityResponse,
  ReadyWorkInput,
  ReadyWorkResponse,
  ReacquireWorkSessionInput,
  RenewWorkSessionInput,
  ReportProgressInput,
  ResumeWorkSessionInput,
  ResumeWorkSessionResponse,
  StopWorkSessionInput,
  WorkSessionResponse,
  WorkSessionsListInput,
  WorkSessionsResponse,
} from "./sessions.ts";

// Every MCP tool an agent can call, as a contract. The server registers a handler for each one,
// and `pnpm gen` writes their JSON Schemas to /contract/mcp-tools.json.
//
// These are exactly the project-work operations a Contribute or Read agent key may reach:
// issues, comments, knowledge, and the activity feed. Membership, project access grants,
// workspace administration, and instance settings are deliberately absent — they are human
// operations and no agent key is accepted for them.
export interface ToolContract {
  name: string;
  description: string;
  input: z.ZodObject;
  output: z.ZodObject;
}

const id = (name: string) => z.string().min(1).meta({ description: name });

const listProjects = {
  name: "list_projects",
  description:
    "List the projects this agent key can reach in its workspace. Membership alone grants nothing; only projects in the key's scope appear.",
  input: z.object({ workspaceId: id("The workspace the key is scoped to") }),
  output: z.object({ projects: ProjectsResponse }),
};

const getProject = {
  name: "get_project",
  description: "Read one project the agent key has Read access to.",
  input: z.object({ projectId: id("The project id") }),
  output: z.object({ project: Project }),
};

const listIssues = {
  name: "list_issues",
  description: "List the issues in an in-scope project.",
  input: z.object({ projectId: id("The project id") }),
  output: z.object({ issues: IssuesResponse }),
};

const getIssue = {
  name: "get_issue",
  description:
    "Read one issue in an in-scope project. The issue includes its structured links (PRs, commits, docs and other web URLs) with each link's kind.",
  input: z.object({ issueId: id("The issue id") }),
  output: z.object({ issue: IssueDetail }),
};

const createIssue = {
  name: "create_issue",
  description:
    "Create an issue in an in-scope project. Omitted status defaults to `todo` (ready work); pass `backlog` to stage it for triage. Priority and sortOrder may be set at creation; omitted priority defaults to none and omitted sortOrder is spaced by 65535 from the project-local issue number. Requires Contribute access on the key and on its human owner.",
  input: CreateIssueRequest.extend({ projectId: id("The project id") }),
  output: z.object({ issue: Issue }),
};

const updateIssue = {
  name: "update_issue",
  description:
    "Edit an issue's title or body, move it through the six-state workflow (`backlog`, `todo`, `in_progress`, `review`, `done`, `cancelled` — only done and cancelled set closedAt), change its priority or sortOrder (a float; the midpoint of two neighbours moves one card without rewriting them), or set/clear its assignee (`{\"type\":\"human\"|\"agent\",\"id\":\"...\"}`, or null to clear). An assignee must be an active member or a registered agent in the workspace. Requires Contribute access and, for an agent, a live work session on the issue. The actor recorded is the agent, not its human owner.",
  input: UpdateIssueRequest.extend({ issueId: id("The issue id") }),
  output: z.object({ issue: Issue }),
};

// Directed blocked_by dependencies (#86/#94). An issue with any non-terminal blocker is
// omitted from ready work, so agents cannot claim downstream work before its prerequisites
// reach done or cancelled; review is a handoff and still blocks.
// Modifying an edge needs Contribute; reading either direction needs only Read.
const addBlockedBy = {
  name: "add_blocked_by",
  description:
    "Record that an issue is blocked by another issue in the same project. A self-link, a cross-project link, and any edge that would form a cycle are refused. Requires Contribute access.",
  input: z.object({
    issueId: id("The issue that is being blocked"),
    blockedByIssueId: id("The issue in the same project that blocks it"),
  }),
  output: z.object({ dependency: IssueDependency }),
};

const removeBlockedBy = {
  name: "remove_blocked_by",
  description:
    "Remove a blocked_by relation between two issues in the same project. Requires Contribute access; removing a relation that is not there is a no-op.",
  input: z.object({
    issueId: id("The issue that is being unblocked"),
    blockedByIssueId: id("The issue that no longer blocks it"),
  }),
  output: z.object({ removed: z.literal(true) }),
};

const listBlockedBy = {
  name: "list_blocked_by",
  description:
    "List the issues that block an issue (its prerequisites, in any status). Read access is enough.",
  input: z.object({ issueId: id("The issue id") }),
  output: z.object({ issues: IssuesResponse }),
};

const listBlocking = {
  name: "list_blocking",
  description:
    "List the issues that an issue blocks (its dependants, in any status). Read access is enough.",
  input: z.object({ issueId: id("The issue id") }),
  output: z.object({ issues: IssuesResponse }),
};

const listComments = {
  name: "list_comments",
  description: "List the comments on an in-scope issue.",
  input: z.object({ issueId: id("The issue id") }),
  output: z.object({ comments: IssueCommentsResponse }),
};

const createComment = {
  name: "create_comment",
  description: "Comment on an in-scope issue. Requires Contribute access.",
  input: CreateIssueCommentRequest.extend({ issueId: id("The issue id") }),
  output: z.object({ comment: IssueComment }),
};

// Structured issue links (#87). Adding or removing one requires Contribute access; reading
// them is part of get_issue and needs only Read. Like comments, a link needs no work session.
const addIssueLink = {
  name: "add_issue_link",
  description:
    "Attach a PR, commit, external doc, or other web URL to an in-scope issue. Requires Contribute access. Only http and https URLs are accepted, and the same URL cannot be attached twice to one issue. The actor recorded is the agent, not its human owner.",
  input: CreateIssueLinkRequest.extend({ issueId: id("The issue id") }),
  output: z.object({ link: IssueLink }),
};

const removeIssueLink = {
  name: "remove_issue_link",
  description:
    "Remove a previously attached link from an in-scope issue. Requires Contribute access. Removing a link that is not attached is an error, not a silent no-op.",
  input: z.object({ issueId: id("The issue id"), linkId: id("The link id") }),
  output: z.object({ removed: z.boolean() }),
};

const listActivity = {
  name: "list_activity",
  description: "Read an in-scope project's activity feed, including which agent performed each action.",
  input: z.object({ projectId: id("The project id") }),
  output: z.object({ activity: ProjectActivityResponse }),
};

const listKnowledge = {
  name: "list_knowledge",
  description: "List the knowledge entries in an in-scope project.",
  input: z.object({ projectId: id("The project id") }),
  output: z.object({ entries: KnowledgeEntriesResponse }),
};

const getKnowledge = {
  name: "get_knowledge",
  description: "Read one knowledge entry in an in-scope project.",
  input: z.object({ entryId: id("The knowledge entry id") }),
  output: z.object({ entry: KnowledgeEntry }),
};

const createKnowledge = {
  name: "create_knowledge",
  description: "Create a knowledge entry in an in-scope project. Requires Contribute access.",
  input: CreateKnowledgeEntryRequest.extend({ projectId: id("The project id") }),
  output: z.object({ entry: KnowledgeEntry }),
};

const updateKnowledge = {
  name: "update_knowledge",
  description: "Edit a knowledge entry in an in-scope project. Requires Contribute access.",
  input: UpdateKnowledgeEntryRequest.extend({ entryId: id("The knowledge entry id") }),
  output: z.object({ entry: KnowledgeEntry }),
};

// Run reporting (issue #34). The single static /mcp endpoint cannot distinguish
// concurrent clients, so an explicit runId or the harness's (harness, nativeSessionId)
// key correlates a report. The bearer key decides the agent and workspace; no lease is
// implied by a check-in. Per-CLI wiring of this tool follows in #44 and #45.
const runCheckin = {
  name: "orrery_run_checkin",
  description:
    "Report a harness conversation's identity and metadata. Correlate by an explicit runId or by the harness's (harness, nativeSessionId) key — send runKey as null when only a runId is known; a new key starts a run, the same key resumes it. Report model and harnessVersion directly or under `reported` (#29); they are stored only as reported and missing values stay unknown. This tool does not claim work or renew a lease.",
  input: RunReportInput,
  output: RunReportResponse,
};

// Work sessions and renewable claims (issue #36). Claiming is idempotent for helpers that
// pass the same (agent, run, issue): they join one coordinated session. Renew, progress,
// stop, and every fenced issue write require a live session the agent holds; reads, issue
// creation, comments, and knowledge edits need none. A stale write is never a fresh claim.
const claimIssue = {
  name: "claim_issue",
  description:
    "Claim a `todo` issue this agent needs to work on, for this agent and run; the claim atomically moves it to `in_progress`. Backlog, review and terminal issues are refused. An agent may claim only work that is unassigned or assigned to that same agent; issues assigned to a human or another agent are refused. One active session per issue: a second worker is refused. Helpers on the same issue pass the same runId and join the existing session. The claim is a five-minute lease in database time; renew it while working.",
  input: ClaimWorkSessionInput,
  output: WorkSessionResponse,
};

const renewClaim = {
  name: "renew_claim",
  description:
    "Check in on an issue this agent currently holds and refresh its five-minute lease in database time. Requires a live session; an expired or released session is never renewed or silently reacquired. Pass sessionId to fence a delayed call from an interrupted session: it is refused if that session is no longer the live one, even after reacquisition. The returned session carries stopRequested, stopRequestedAt and stopReason: when stopRequested is true a human has asked you to stop, so flush a brief handoff and call stop_session promptly. The five-minute lease remains the hard backstop.",
  input: RenewWorkSessionInput,
  output: WorkSessionResponse,
};

const reportProgress = {
  name: "report_progress",
  description:
    "Record progress on the live session this agent holds for an issue. Progress is stored independently of the lease, so an interruption never erases it. Requires a live session; pass sessionId to refuse a delayed report from an expired session instead of writing to a newer one. The returned session carries stopRequested, stopRequestedAt and stopReason: check them on every report and stop promptly if a human has asked you to stop.",
  input: ReportProgressInput,
  output: WorkSessionResponse,
};

const stopSession = {
  name: "stop_session",
  description:
    "Complete or release the live session this agent holds for an issue. Requires a live session. `outcome` defaults to `review`: the issue moves to the non-terminal review handoff with closedAt null. `outcome: done` closes the issue (closedAt set, unblocking dependents) and requires Contribute or Manage; `outcome: released` gives up the claim and returns an in_progress issue to todo. Pass sessionId to fence a delayed completion from an interrupted session: it is refused rather than completing a newer session.",
  input: StopWorkSessionInput,
  output: WorkSessionResponse,
};

const getWorkSession = {
  name: "get_work_session",
  description:
    "Read the latest work session recorded for an issue, from any agent, including its recorded progress and lease deadline. This is a read: it needs no live claim and never renews one.",
  input: GetWorkSessionInput,
  output: WorkSessionResponse,
};

// Resume and reacquisition (issue #40). Resume is a pure read for the original run: it
// reports whether that run still holds a live claim, has an expired one, or never claimed,
// and keeps the recorded progress visible. Reacquire re-arms only the run's own expired
// claim, and only when the issue has no live claimant and is not paused for input. Neither
// call ever resurrects an expired lease or turns a stale call into a fresh claim.
const resumeWorkSession = {
  name: "resume_work_session",
  description:
    "Inspect the work session the given run (the harness conversation, including resumes) recorded for an issue. Returns disposition active, expired, ended or none, and the session with its recorded progress. This is a read in database time: it never renews or resurrects an expired lease.",
  input: ResumeWorkSessionInput,
  output: ResumeWorkSessionResponse,
};

const reacquireWorkSession = {
  name: "reacquire_issue",
  description:
    "Reacquire this run's expired claim on an issue after an interruption. Creates a new active session for the same agent, run, workspace and issue, carrying forward the recorded progress, and only when no other worker holds a live claim and the issue is not paused for input. Retries with the same run return the same session; a stale call on an expired session is refused, never turned into a fresh claim.",
  input: ReacquireWorkSessionInput,
  output: WorkSessionResponse,
};

const readyWork = {
  name: "ready_work",
  description:
    "List minimal ready work in a project: `todo` issues that are not Needs input, have no live active session, and have no blocker whose status is not done or cancelled, evaluated in database time. `backlog`, `in_progress`, `review` and terminal issues are never offered. Optional `filter` is all (default), assignedToMe or unassigned; an agent never sees issues assigned to a human or another agent. Work assigned to the caller sorts first, then priority urgent > high > medium > low > none, then sortOrder ascending, then creation time ascending. Needs no claim.",
  input: ReadyWorkInput,
  output: z.object({ issues: ReadyWorkResponse }),
};

const allSessionsForIssue = {
  name: "list_work_sessions",
  description:
    "List the work sessions recorded for an issue, including completed, released and expired ones. This is a read and needs no claim.",
  input: WorkSessionsListInput,
  output: z.object({ sessions: WorkSessionsResponse }),
};

// Ephemeral telemetry (#83): append-only thought/action/status entries stay with the work
// session and are never mixed into issue comments. Appending requires a live session held
// by this agent; reading needs only Read access on the issue's project.
const logSessionActivity = {
  name: "log_session_activity",
  description:
    "Append an ephemeral thought, action or status entry to the live work session this agent holds on an issue. Optional detail is an extensible JSON object for structured blocks. Entries are kept independently of the claim lease, so an interrupted or completed session keeps its whole trail, and are never posted as issue comments. Requires a live session; pass sessionId to refuse a delayed write from an expired session instead of writing to a newer one.",
  input: LogSessionActivityInput,
  output: LogSessionActivityResponse,
};

const listSessionActivities = {
  name: "list_session_activities",
  description:
    "List the ephemeral thought/action/status timeline of one work session on an issue, newest first. Read access to the issue's project is enough; no claim is needed. These entries are separate from the permanent issue comments and survive expiry or completion.",
  input: ListSessionActivitiesInput,
  output: ListSessionActivitiesResponse,
};

// Human input (issue #41, fallback policy in #42). An agent asks through this tool;
// answering, setting the project policy and setting an issue override are human-only
// REST operations, so no agent key — including a sibling run — can authorize its own
// fallback or answer a question.
const askForInput = {
  name: "ask_for_input",
  description:
    "Ask the team a blocking question about an issue this agent currently holds. Include a concrete proposed fallback; the agent cannot authorize it. The question opens for one hour in database time, keeps the claim while the agent checks in, sets the issue to Needs input and emails the agent's owner. A human with Contribute or Manage answers through the inbox. Only a human may set the project fallback policy or an issue override; the agent cannot authorize its own fallback. At the deadline a require_human question pauses, releasing the claim and keeping Needs input; a fallback_allowed question resolves to fallback_used, clears Needs input and lets the worker continue without releasing its claim.",
  input: AskForInputInput,
  output: QuestionResponse,
};

// Agents read the human's answer back with a separate tool, matching the issue history
// REST route. There is still no MCP answer tool: only the human REST inbox may answer.
const listIssueQuestions = {
  name: "list_issue_questions",
  description:
    "List every question asked about an in-scope issue and its resolution, newest first. A pending question past its one-hour deadline is reported in database time as paused (require_human) or fallback_used (fallback_allowed). A fallback_used question carries authorizedFallback, the proposed fallback the harness may act on; before authorization, on pause or on answer, authorizedFallback is null. Needs no claim; answering remains a human-only REST operation, and a late human answer is a follow-up that never reverses the fallback.",
  input: IssueQuestionParams,
  output: z.object({ questions: InboxResponse }),
};

// Each feature registers only its own tools; `tools` is the complete list used by
// `pnpm gen` to write contract/mcp-tools.json.
export const projectTools: readonly ToolContract[] = [
  listProjects,
  getProject,
  listIssues,
  getIssue,
  createIssue,
  updateIssue,
  addBlockedBy,
  removeBlockedBy,
  listBlockedBy,
  listBlocking,
  listComments,
  createComment,
  addIssueLink,
  removeIssueLink,
  listActivity,
  listKnowledge,
  getKnowledge,
  createKnowledge,
  updateKnowledge,
];

export const runTools: readonly ToolContract[] = [runCheckin];

export const sessionTools: readonly ToolContract[] = [
  claimIssue,
  renewClaim,
  reportProgress,
  stopSession,
  getWorkSession,
  resumeWorkSession,
  reacquireWorkSession,
  readyWork,
  allSessionsForIssue,
  logSessionActivity,
  listSessionActivities,
];

export const questionTools: readonly ToolContract[] = [askForInput, listIssueQuestions];

export const tools: readonly ToolContract[] = [
  ...projectTools,
  ...runTools,
  ...sessionTools,
  ...questionTools,
];
