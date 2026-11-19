import { z } from "zod";
import { Email, Timestamp } from "./common.ts";

// Projects and their content (issue #26). A project belongs to exactly one workspace and
// holds issues, their comments, basic Markdown knowledge entries, and one activity feed.
// Until #27 adds shared-workspace project levels, only a personal workspace's owner can
// create, read, or change projects in their personal workspace, keeping them private.

export const IssueStatus = z.enum(["open", "closed"]).meta({ id: "IssueStatus" });
export type IssueStatus = z.infer<typeof IssueStatus>;

// Every activity event a project records. The event names are stable codes; the summary
// is the human-readable snapshot (an issue or knowledge title) taken when it happened.
export const ProjectActivityType = z
  .enum([
    "project_created",
    "issue_created",
    "issue_edited",
    "issue_commented",
    "issue_closed",
    "issue_reopened",
    "knowledge_created",
    "knowledge_edited",
  ])
  .meta({ id: "ProjectActivityType" });
export type ProjectActivityType = z.infer<typeof ProjectActivityType>;

// Who did something: the stable human id is the identity, the email is what a project's
// readers see, and both stay attached to the action after it happened.
export const Actor = z.object({ humanId: z.string(), email: Email }).meta({ id: "Actor" });
export type Actor = z.infer<typeof Actor>;

export const Project = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    createdAt: Timestamp,
    createdBy: Actor,
  })
  .meta({ id: "Project" });
export type Project = z.infer<typeof Project>;

export const ProjectsResponse = z.array(Project).meta({ id: "ProjectsResponse" });
export type ProjectsResponse = z.infer<typeof ProjectsResponse>;

export const CreateProjectRequest = z
  .object({
    name: z.string().trim().min(1, "Name the project.").max(120),
  })
  .meta({ id: "CreateProjectRequest" });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// An issue as its readers see it. `number` is the project-local issue number (1, 2, …),
// not a global identity; the id is the stable one. `closedAt` is set only while closed.
export const Issue = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.int().positive(),
    title: z.string(),
    body: z.string(),
    status: IssueStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    closedAt: Timestamp.nullable(),
    createdBy: Actor,
    updatedBy: Actor,
  })
  .meta({ id: "Issue" });
export type Issue = z.infer<typeof Issue>;

export const IssuesResponse = z.array(Issue).meta({ id: "IssuesResponse" });
export type IssuesResponse = z.infer<typeof IssuesResponse>;

// The issue body is Markdown, stored as written. The cap bounds the work of parsing and
// storing it; it is not a rendering rule.
export const IssueBody = z.string().max(100_000).meta({ id: "IssueBody" });
export type IssueBody = z.infer<typeof IssueBody>;

export const CreateIssueRequest = z
  .object({
    title: z.string().trim().min(1, "Give the issue a title.").max(200),
    body: IssueBody.optional(),
  })
  .meta({ id: "CreateIssueRequest" });
export type CreateIssueRequest = z.infer<typeof CreateIssueRequest>;

// Editing an issue, closing it, or reopening it. Every field is optional; a request that
// changes nothing is answered with the issue unchanged. Status is a transition, so
// "closed" while already closed is a no-op, not an error.
export const UpdateIssueRequest = z
  .object({
    title: z.string().trim().min(1, "Give the issue a title.").max(200).optional(),
    body: IssueBody.optional(),
    status: IssueStatus.optional(),
  })
  .meta({ id: "UpdateIssueRequest" });
export type UpdateIssueRequest = z.infer<typeof UpdateIssueRequest>;

export const IssueComment = z
  .object({
    id: z.string(),
    issueId: z.string(),
    body: z.string(),
    createdAt: Timestamp,
    author: Actor,
  })
  .meta({ id: "IssueComment" });
export type IssueComment = z.infer<typeof IssueComment>;

export const IssueCommentsResponse = z
  .array(IssueComment)
  .meta({ id: "IssueCommentsResponse" });
export type IssueCommentsResponse = z.infer<typeof IssueCommentsResponse>;

export const CreateIssueCommentRequest = z
  .object({
    body: z.string().trim().min(1, "Write a comment.").max(20_000),
  })
  .meta({ id: "CreateIssueCommentRequest" });
export type CreateIssueCommentRequest = z.infer<typeof CreateIssueCommentRequest>;

// A basic Markdown knowledge entry: a title and a body, created and edited in the
// project. This is not the full vault editor (#6); it is the smallest entry that keeps
// knowledge with the project and attributes who wrote it.
export const KnowledgeEntry = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    body: z.string(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    createdBy: Actor,
    updatedBy: Actor,
  })
  .meta({ id: "KnowledgeEntry" });
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

export const KnowledgeEntriesResponse = z
  .array(KnowledgeEntry)
  .meta({ id: "KnowledgeEntriesResponse" });
export type KnowledgeEntriesResponse = z.infer<typeof KnowledgeEntriesResponse>;

export const KnowledgeBody = z.string().max(100_000).meta({ id: "KnowledgeBody" });
export type KnowledgeBody = z.infer<typeof KnowledgeBody>;

export const CreateKnowledgeEntryRequest = z
  .object({
    title: z.string().trim().min(1, "Give the entry a title.").max(200),
    body: KnowledgeBody.optional(),
  })
  .meta({ id: "CreateKnowledgeEntryRequest" });
export type CreateKnowledgeEntryRequest = z.infer<typeof CreateKnowledgeEntryRequest>;

export const UpdateKnowledgeEntryRequest = z
  .object({
    title: z.string().trim().min(1, "Give the entry a title.").max(200).optional(),
    body: KnowledgeBody.optional(),
  })
  .meta({ id: "UpdateKnowledgeEntryRequest" });
export type UpdateKnowledgeEntryRequest = z.infer<typeof UpdateKnowledgeEntryRequest>;

// One project activity event, with the human who caused it. `issueId` and
// `knowledgeEntryId` point at the item when the event concerns one.
export const ProjectActivity = z
  .object({
    id: z.string(),
    projectId: z.string(),
    type: ProjectActivityType,
    summary: z.string(),
    issueId: z.string().nullable(),
    knowledgeEntryId: z.string().nullable(),
    createdAt: Timestamp,
    actor: Actor,
  })
  .meta({ id: "ProjectActivity" });
export type ProjectActivity = z.infer<typeof ProjectActivity>;

export const ProjectActivityResponse = z
  .array(ProjectActivity)
  .meta({ id: "ProjectActivityResponse" });
export type ProjectActivityResponse = z.infer<typeof ProjectActivityResponse>;
