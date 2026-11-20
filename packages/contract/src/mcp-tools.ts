import { z } from "zod";
import {
  CreateIssueCommentRequest,
  CreateIssueRequest,
  CreateKnowledgeEntryRequest,
  Issue,
  IssueComment,
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
import { RunReportInput, RunReportResponse } from "./runs.ts";
import {
  ClaimWorkSessionInput,
  GetWorkSessionInput,
  ReadyWorkInput,
  ReadyWorkResponse,
  RenewWorkSessionInput,
  ReportProgressInput,
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
  description: "Read one issue in an in-scope project.",
  input: z.object({ issueId: id("The issue id") }),
  output: z.object({ issue: Issue }),
};

const createIssue = {
  name: "create_issue",
  description:
    "Create an issue in an in-scope project. Requires Contribute access on the key and on its human owner.",
  input: CreateIssueRequest.extend({ projectId: id("The project id") }),
  output: z.object({ issue: Issue }),
};

const updateIssue = {
  name: "update_issue",
  description:
    "Edit an issue's title or body, or close/reopen it. Requires Contribute access. The actor recorded is the agent, not its human owner.",
  input: UpdateIssueRequest.extend({ issueId: id("The issue id") }),
  output: z.object({ issue: Issue }),
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
    "Claim an issue this agent needs to work on, for this agent and run. The issue may already be closed: a worker reopening it must claim it first, because a fenced update_issue needs a live session. One active session per issue: a second worker is refused. Helpers on the same issue pass the same runId and join the existing session. The claim is a five-minute lease in database time; renew it while working.",
  input: ClaimWorkSessionInput,
  output: WorkSessionResponse,
};

const renewClaim = {
  name: "renew_claim",
  description:
    "Check in on an issue this agent currently holds and refresh its five-minute lease in database time. Requires a live session; an expired or released session is never renewed or silently reacquired.",
  input: RenewWorkSessionInput,
  output: WorkSessionResponse,
};

const reportProgress = {
  name: "report_progress",
  description:
    "Record progress on the live session this agent holds for an issue. Progress is stored independently of the lease, so an interruption never erases it. Requires a live session.",
  input: ReportProgressInput,
  output: WorkSessionResponse,
};

const stopSession = {
  name: "stop_session",
  description:
    "Complete or release the live session this agent holds for an issue. Requires a live session; stopping is distinct from closing the issue.",
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

const readyWork = {
  name: "ready_work",
  description:
    "List minimal ready work in a project: open issues that are not Needs input and have no live active session, evaluated in database time. Needs no claim.",
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

// Each feature registers only its own tools; `tools` is the complete list used by
// `pnpm gen` to write contract/mcp-tools.json.
export const projectTools: readonly ToolContract[] = [
  listProjects,
  getProject,
  listIssues,
  getIssue,
  createIssue,
  updateIssue,
  listComments,
  createComment,
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
  readyWork,
  allSessionsForIssue,
];

export const tools: readonly ToolContract[] = [...projectTools, ...runTools, ...sessionTools];
