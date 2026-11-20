import { z } from "zod";
import { Email, Timestamp, WorkspaceKind } from "./common.ts";

// Projects and their content (issue #26, shared projects in #27). A project belongs to
// exactly one workspace and holds issues, their comments, basic Markdown knowledge
// entries, and one activity feed. A personal project stays with its workspace owner. In
// a shared workspace the effective level is the caller's grant, or Manage for an owner.

// The cumulative project levels (#20). Manage includes Contribute, and Contribute
// includes Read. They grant no workspace-wide authority.
export const ProjectAccessLevel = z
  .enum(["read", "contribute", "manage"])
  .meta({ id: "ProjectAccessLevel" });
export type ProjectAccessLevel = z.infer<typeof ProjectAccessLevel>;

export const IssueStatus = z.enum(["open", "closed"]).meta({ id: "IssueStatus" });
export type IssueStatus = z.infer<typeof IssueStatus>;

// Every activity event a project records. The event names are stable codes; the summary
// is the human-readable snapshot (an issue or knowledge title) taken when it happened.
export const ProjectActivityType = z
  .enum([
    "project_created",
    "project_renamed",
    "issue_created",
    "issue_edited",
    "issue_commented",
    "issue_closed",
    "issue_reopened",
    "issue_question_asked",
    "issue_question_answered",
    "issue_question_paused",
    "issue_stop_requested",
    "knowledge_created",
    "knowledge_edited",
  ])
  .meta({ id: "ProjectActivityType" });
export type ProjectActivityType = z.infer<typeof ProjectActivityType>;

// Who did something. The stable identity is either a human or an agent: an agent's work
// is attributed to the agent itself, never misattributed to the human who owns its key.
// `displayName` is the stable label readers see (the human's email or the agent's name),
// so a reader never has to guess which identity an event names. A deactivated human
// keeps that same identity and label: `deactivated` marks it suspended instead of
// dropping the author and showing "unknown" (#38).
export const Actor = z
  .object({
    humanId: z.string().nullable().optional(),
    email: Email.nullable().optional(),
    agentId: z.string().nullable().optional(),
    agentName: z.string().nullable().optional(),
    displayName: z.string(),
    deactivated: z.boolean().optional(),
  })
  .meta({ id: "Actor" });
export type Actor = z.infer<typeof Actor>;

export const Project = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    createdAt: Timestamp,
    createdBy: Actor,
    // The workspace kind is part of the project's own view so a client knows whether
    // direct access grants apply; personal projects have no collaborators.
    workspaceKind: WorkspaceKind,
    // The caller's effective level: the workspace owner's Manage, a shared project
    // grant, or the personal workspace owner's Manage. It is computed per request.
    accessLevel: ProjectAccessLevel,
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

// A project manager's configuration change. Only Manage access may rename a project;
// the name is the project setting this slice exposes.
export const UpdateProjectRequest = z
  .object({
    name: z.string().trim().min(1, "Name the project.").max(120),
  })
  .meta({ id: "UpdateProjectRequest" });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// One explicit project access grant. Workspace owners have Manage implicitly and are not
// listed here; the grant records who granted the level, so access-change history can
// name both sides.
export const ProjectAccessGrant = z
  .object({
    humanId: z.string(),
    email: Email,
    level: ProjectAccessLevel,
    grantedBy: Actor,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "ProjectAccessGrant" });
export type ProjectAccessGrant = z.infer<typeof ProjectAccessGrant>;

export const ProjectAccessGrantsResponse = z
  .array(ProjectAccessGrant)
  .meta({ id: "ProjectAccessGrantsResponse" });
export type ProjectAccessGrantsResponse = z.infer<typeof ProjectAccessGrantsResponse>;

// Granting or changing access always targets a current member of the project's shared
// workspace by email. The level is cumulative; the project manager's own level is the
// ceiling for what they may grant in a later slice, but Manage is the only required level now.
export const SetProjectAccessRequest = z
  .object({
    email: Email,
    level: ProjectAccessLevel,
  })
  .meta({ id: "SetProjectAccessRequest" });
export type SetProjectAccessRequest = z.infer<typeof SetProjectAccessRequest>;

// Every recorded project access-change event (#27). A grant has a level and no previous
// level; a level change has both; a revocation has only the previous level. Secrets and
// emails are not part of the event payload; the subject id is the stable identity.
export const ProjectAccessEventType = z
  .enum(["project_access_granted", "project_access_level_changed", "project_access_revoked"])
  .meta({ id: "ProjectAccessEventType" });
export type ProjectAccessEventType = z.infer<typeof ProjectAccessEventType>;

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
