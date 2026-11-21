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

// The fixed six-state workflow (#94). `needs_input` is deliberately not a status: it stays
// an orthogonal flag derived from the questions table (ADR-0005). `done` and `cancelled`
// are terminal (they set closed_at and unblock dependents); `review` is a non-terminal
// handoff. `todo` is the agent-ready queue; `backlog` is triage.
export const IssueStatus = z
  .enum(["backlog", "todo", "in_progress", "review", "done", "cancelled"])
  .meta({ id: "IssueStatus" });
export type IssueStatus = z.infer<typeof IssueStatus>;

// Statuses whose closed_at is set. Kept beside the enum so every service uses one rule.
export const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
export function isTerminalIssueStatus(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}

// Human-set importance (#88). `none` is the default so an unordered board stays neutral.
// The order here is also the ready-work order: urgent first, none last.
export const IssuePriority = z.enum(["urgent", "high", "medium", "low", "none"]).meta({
  id: "IssuePriority",
});
export type IssuePriority = z.infer<typeof IssuePriority>;

// A card's position in its project's board order. It is a float so a client can move one
// card between two neighbours by storing their midpoint, rewriting only that one row.
// New issues are spaced in increments of ISSUE_SORT_STEP by project-local issue number.
export const IssueSortOrder = z.number().finite().meta({ id: "IssueSortOrder" });
export type IssueSortOrder = z.infer<typeof IssueSortOrder>;

// Board assignment (#84). An issue may be assigned to a human or to a registered agent in
// the workspace. Assignment is a pull-queue hint, not a launch trigger: it never replaces
// a claim. The pair is stored as two columns in the database with a CHECK that keeps both
// null or both present, and the service validates the identity against current membership.
export const AssigneeType = z.enum(["human", "agent"]).meta({ id: "AssigneeType" });
export type AssigneeType = z.infer<typeof AssigneeType>;

export const Assignee = z
  .object({
    type: AssigneeType,
    id: z.string().trim().min(1).max(200),
  })
  .meta({ id: "Assignee" });
export type Assignee = z.infer<typeof Assignee>;

// The spacing between newly created cards, shared by the server's initializer and the UI's
// midpoint reorder so both agree on how far apart neighbours start.
export const ISSUE_SORT_STEP = 65535;

// Fallback policy (#42). A project defaults to `require_human`: at the one-hour deadline
// the question pauses and the claim is released. `fallback_allowed` authorizes returning
// the agent's proposed fallback to the harness instead. An issue may tighten the project
// policy with a `require_human` override; only project Manage may loosen one (#42's
// transition/permission matrix lives in the projects service, never in a transport).
export const FallbackPolicy = z
  .enum(["require_human", "fallback_allowed"])
  .meta({ id: "FallbackPolicy" });
export type FallbackPolicy = z.infer<typeof FallbackPolicy>;

// `null` means "no override": the issue uses its project's policy.
export const FallbackPolicyOverride = FallbackPolicy.nullable().meta({
  id: "FallbackPolicyOverride",
});
export type FallbackPolicyOverride = z.infer<typeof FallbackPolicyOverride>;

// Every activity event a project records. The event names are stable codes; the summary
// is the human-readable snapshot (an issue or knowledge title) taken when it happened.
export const ProjectActivityType = z
  .enum([
    "project_created",
    "project_renamed",
    "project_fallback_policy_changed",
    "issue_created",
    "issue_edited",
    "issue_commented",
    // #94: a work session's default "review" completion hands the issue to a human before
    // it is closed; "done" uses issue_closed and a status change out of a terminal state
    // uses issue_reopened.
    "issue_review_handoff",
    "issue_closed",
    "issue_reopened",
    "issue_dependency_added",
    "issue_dependency_removed",
    "issue_link_added",
    "issue_link_removed",
    "issue_question_asked",
    "issue_question_answered",
    "issue_question_paused",
    "issue_question_fallback_used",
    "issue_question_follow_up",
    "issue_fallback_policy_override_changed",
    "issue_stop_requested",
    // #97: label metadata changes are project events; attaching, detaching and reparenting
    // are issue events, so the prefix keeps each event's target column consistent.
    "project_label_created",
    "project_label_edited",
    "project_label_deleted",
    "issue_label_added",
    "issue_label_removed",
    "issue_parent_changed",
    // #98: trash lifecycle events. Both carry the issue as their target, so the prefix
    // keeps project_activity_target_matches_type consistent with every other issue event.
    "issue_deleted",
    "issue_restored",
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

// The assignee is surfaced with the same identity shape as authorship so a card can show
// one badge for either kind. Null means unassigned; a deactivated assignee keeps its label.
export const IssueAssignee = Actor.nullable().meta({ id: "IssueAssignee" });
export type IssueAssignee = z.infer<typeof IssueAssignee>;

// A project's short, immutable key (#95). It is unique within one workspace and forms the
// readable prefix of every issue identifier (`ORR-42`). The database repeats this rule.
export const ProjectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2-10 uppercase letters or digits, starting with a letter.")
  .meta({ id: "ProjectKey" });
export type ProjectKey = z.infer<typeof ProjectKey>;

export const Project = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    // Workspace-unique and immutable after creation; issue identifiers use it as prefix.
    key: ProjectKey,
    createdAt: Timestamp,
    createdBy: Actor,
    // The workspace kind is part of the project's own view so a client knows whether
    // direct access grants apply; personal projects have no collaborators.
    workspaceKind: WorkspaceKind,
    // The caller's effective level: the workspace owner's Manage, a shared project
    // grant, or the personal workspace owner's Manage. It is computed per request.
    accessLevel: ProjectAccessLevel,
    // The project-wide fallback policy (#42); defaults to require_human.
    fallbackPolicy: FallbackPolicy,
  })
  .meta({ id: "Project" });
export type Project = z.infer<typeof Project>;

export const ProjectsResponse = z.array(Project).meta({ id: "ProjectsResponse" });
export type ProjectsResponse = z.infer<typeof ProjectsResponse>;

export const CreateProjectRequest = z
  .object({
    name: z.string().trim().min(1, "Name the project.").max(120),
    // Explicit keys are validated here. When omitted the service derives a valid,
    // workspace-unique key from the name.
    key: ProjectKey.optional(),
  })
  .meta({ id: "CreateProjectRequest" });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// A project manager's configuration change. Only Manage access may rename a project;
// the name is the project setting this slice exposes. A key is immutable (#95): the
// field is accepted only so the service can refuse an attempted change with a stable
// problem instead of silently stripping it.
export const UpdateProjectRequest = z
  .object({
    name: z.string().trim().min(1, "Name the project.").max(120),
    key: ProjectKey.optional(),
  })
  .meta({ id: "UpdateProjectRequest" });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// A human, project Manage setting changes the project-wide fallback policy. Agents have no
// path to this setting: it is a human-session REST route with no MCP tool.
export const SetProjectFallbackPolicyRequest = z
  .object({ fallbackPolicy: FallbackPolicy })
  .meta({ id: "SetProjectFallbackPolicyRequest" });
export type SetProjectFallbackPolicyRequest = z.infer<typeof SetProjectFallbackPolicyRequest>;

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

// A project-scoped label (#97). Names are unique per project ignoring case; the service and
// the database's expression index both enforce that. A color is a six-digit hex value so a
// client can render a consistent badge without parsing arbitrary CSS.
export const LabelColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color such as #ff0000.")
  .meta({ id: "LabelColor" });
export type LabelColor = z.infer<typeof LabelColor>;

export const ProjectLabel = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    color: LabelColor,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    createdBy: Actor,
  })
  .meta({ id: "ProjectLabel" });
export type ProjectLabel = z.infer<typeof ProjectLabel>;

export const ProjectLabelsResponse = z
  .array(ProjectLabel)
  .meta({ id: "ProjectLabelsResponse" });
export type ProjectLabelsResponse = z.infer<typeof ProjectLabelsResponse>;

export const CreateProjectLabelRequest = z
  .object({
    name: z.string().trim().min(1, "Name the label.").max(50),
    color: LabelColor,
  })
  .meta({ id: "CreateProjectLabelRequest" });
export type CreateProjectLabelRequest = z.infer<typeof CreateProjectLabelRequest>;

// Both fields are optional so a partial edit can change just one; a request that changes
// nothing answers with the label unchanged and records no activity.
export const UpdateProjectLabelRequest = z
  .object({
    name: z.string().trim().min(1, "Name the label.").max(50).optional(),
    color: LabelColor.optional(),
  })
  .meta({ id: "UpdateProjectLabelRequest" });
export type UpdateProjectLabelRequest = z.infer<typeof UpdateProjectLabelRequest>;

// An issue as its readers see it. `number` is the project-local issue number (1, 2, …),
// not a global identity; the id is the stable one. `identifier` is the human-readable
// `<PROJECT_KEY>-<NUMBER>` form (#95) carried alongside them; `closedAt` is set exactly
// while the issue is in a terminal state (done or cancelled).
export const Issue = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.int().positive(),
    identifier: z.string(),
    title: z.string(),
    body: z.string(),
    status: IssueStatus,
    priority: IssuePriority,
    sortOrder: IssueSortOrder,
    // The board renders a Needs input column from this flag; it is a human-input pause,
    // not a work-session status (#37/#41).
    needsInput: z.boolean(),
    // Board assignment (#84): null means unassigned, otherwise the human or agent
    // assigned to this issue. Assignment is a pull-queue hint, never a claim.
    assignee: IssueAssignee,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    closedAt: Timestamp.nullable(),
    createdBy: Actor,
    updatedBy: Actor,
    // The issue's explicit override and the policy it resolves to (#42). `null` override
    // means "use the project's policy"; effectiveFallbackPolicy is never null.
    fallbackPolicyOverride: FallbackPolicyOverride,
    effectiveFallbackPolicy: FallbackPolicy,
    // #97: an optional one-level parent in the same project, and the project-scoped labels
    // attached to this issue (empty when none). A subtask is a full, claimable issue; its
    // parent is never an ordering edge — only blocked_by is.
    parentIssueId: z.string().nullable(),
    labels: z.array(ProjectLabel),
  })
  .meta({ id: "Issue" });
export type Issue = z.infer<typeof Issue>;

export const IssuesResponse = z.array(Issue).meta({ id: "IssuesResponse" });
export type IssuesResponse = z.infer<typeof IssuesResponse>;

// A structured link attached to an issue (#87): a PR, a commit, an external doc, or any
// other web URL. `link` is the fallback so a client never has to invent a kind for an
// unfamiliar artifact.
export const IssueLinkKind = z.enum(["pr", "commit", "doc", "link"]).meta({ id: "IssueLinkKind" });
export type IssueLinkKind = z.infer<typeof IssueLinkKind>;

// `z.url()` alone also accepts schemes such as javascript: and file:, which would make a
// stored "link" unsafe to render as an anchor. Restrict the protocol to the web schemes;
// the database repeats this rule so no writer can bypass the contract.
export const IssueLinkUrl = z
  .url()
  .max(2048)
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Only http and https links are allowed." },
  )
  .meta({ id: "IssueLinkUrl" });
export type IssueLinkUrl = z.infer<typeof IssueLinkUrl>;

export const IssueLink = z
  .object({
    id: z.string(),
    issueId: z.string(),
    url: IssueLinkUrl,
    title: z.string(),
    kind: IssueLinkKind,
    createdAt: Timestamp,
    createdBy: Actor,
  })
  .meta({ id: "IssueLink" });
export type IssueLink = z.infer<typeof IssueLink>;

export const CreateIssueLinkRequest = z
  .object({
    url: IssueLinkUrl,
    title: z.string().trim().min(1, "Give the link a title.").max(200),
    kind: IssueLinkKind,
  })
  .meta({ id: "CreateIssueLinkRequest" });
export type CreateIssueLinkRequest = z.infer<typeof CreateIssueLinkRequest>;

// The issue detail is the issue plus its structured links. The list and mutation responses
// stay plain Issues so a project-wide listing does not pay for every issue's link rows.
export const IssueDetail = Issue.extend({ links: z.array(IssueLink) }).meta({ id: "IssueDetail" });
export type IssueDetail = z.infer<typeof IssueDetail>;

// The issue body is Markdown, stored as written. The cap bounds the work of parsing and
// storing it; it is not a rendering rule.
export const IssueBody = z.string().max(100_000).meta({ id: "IssueBody" });
export type IssueBody = z.infer<typeof IssueBody>;

export const CreateIssueRequest = z
  .object({
    title: z.string().trim().min(1, "Give the issue a title.").max(200),
    body: IssueBody.optional(),
    // #94: new issues are ready work unless explicitly staged in the backlog triage queue.
    status: IssueStatus.optional(),
    priority: IssuePriority.optional(),
    sortOrder: IssueSortOrder.optional(),
    // #97: create a subtask directly. The service resolves the parent in this project and
    // refuses a self-parent, a foreign parent, or a parent that already has one.
    parentIssueId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .meta({ id: "CreateIssueRequest" });
export type CreateIssueRequest = z.infer<typeof CreateIssueRequest>;

// Editing an issue, moving it through the workflow, or closing it. Every field is
// optional; a request that changes nothing is answered with the issue unchanged. Status
// is a transition, so naming the current status is a no-op, not an error.
export const UpdateIssueRequest = z
  .object({
    title: z.string().trim().min(1, "Give the issue a title.").max(200).optional(),
    body: IssueBody.optional(),
    status: IssueStatus.optional(),
    priority: IssuePriority.optional(),
    sortOrder: IssueSortOrder.optional(),
    // Set or clear assignment (#84). Omitting the field leaves it unchanged; an explicit
    // null clears it. Only Contribute and Manage may change it, just like other issue edits.
    assignee: Assignee.nullable().optional(),
    // #97: set or clear the one-level parent; omitting the field leaves it unchanged.
    parentIssueId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .meta({ id: "UpdateIssueRequest" });
export type UpdateIssueRequest = z.infer<typeof UpdateIssueRequest>;

// A human with Contribute or Manage sets or clears an issue's fallback override. Setting
// `require_human` (tightening) needs only Contribute; loosening to `fallback_allowed`,
// including clearing a require_human override under a fallback_allowed project, needs
// Manage. Agents cannot reach this setting at all.
export const SetIssueFallbackPolicyRequest = z
  .object({ override: FallbackPolicyOverride })
  .meta({ id: "SetIssueFallbackPolicyRequest" });
export type SetIssueFallbackPolicyRequest = z.infer<typeof SetIssueFallbackPolicyRequest>;

// A directed dependency: `issueId` is blocked by `blockedByIssueId`. Both issues live in
// one project, neither may be the other, and the graph is acyclic. The edge keeps the
// identity that created it so the project's activity can name who changed the plan.
export const IssueDependency = z
  .object({
    issueId: z.string(),
    blockedByIssueId: z.string(),
    createdAt: Timestamp,
    createdBy: Actor,
  })
  .meta({ id: "IssueDependency" });
export type IssueDependency = z.infer<typeof IssueDependency>;

// Adding a blocker names the other issue in the same project. The service resolves both
// ids before writing, so no database id is taken from anything else.
export const AddBlockedByRequest = z
  .object({
    blockedByIssueId: z.string().trim().min(1, "Choose the blocking issue.").max(200),
  })
  .meta({ id: "AddBlockedByRequest" });
export type AddBlockedByRequest = z.infer<typeof AddBlockedByRequest>;

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
