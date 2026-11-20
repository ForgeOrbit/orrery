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

export const tools: readonly ToolContract[] = [
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
