import { randomUUID } from "node:crypto";
import {
  FallbackPolicy,
  ISSUE_SORT_STEP,
  IssueStatus,
  ProjectAccessEventType,
  ProjectAccessLevel,
  WorkspaceKind,
  type Actor,
  type AgentIdentity,
  type AddBlockedByRequest,
  type Assignee,
  type AssigneeType,
  type CreateIssueCommentRequest,
  type CreateIssueLinkRequest,
  type CreateIssueRequest,
  type CreateKnowledgeEntryRequest,
  type CreateProjectRequest,
  type Issue,
  type IssueComment,
  type IssueDependency,
  type IssueDetail,
  type IssueLink,
  IssueLinkKind,
  IssuePriority,
  type KnowledgeEntry,
  type Project,
  type ProjectAccessGrant,
  type ProjectActivity,
  type ProjectActivityType,
  type SetIssueFallbackPolicyRequest,
  type SetProjectAccessRequest,
  type SetProjectFallbackPolicyRequest,
  type UpdateIssueRequest,
  type UpdateKnowledgeEntryRequest,
  type UpdateProjectRequest,
} from "@orrery/contract";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { uniqueConstraintName } from "../../platform/errors.ts";
import {
  agentApiKeys,
  agents,
  humans,
  issueComments,
  issueDependencies,
  issueLinks,
  issues,
  knowledgeEntries,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projects,
  questions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";

// The service is the only file in this feature that decides anything. rest.ts calls it.
//
// A personal project belongs to its workspace owner alone. A shared project's effective
// level is Manage for a workspace owner, otherwise the member's explicit grant (Read,
// Contribute, or Manage), otherwise none. Every project query applies the same resolver,
// so no transport can bypass it. Membership alone never grants project access.

export type ProjectsErrorKind =
  | "not_signed_in"
  | "workspace_not_found"
  | "project_not_found"
  | "issue_not_found"
  | "issue_link_not_found"
  | "issue_link_exists"
  | "knowledge_entry_not_found"
  | "project_creation_not_allowed"
  | "insufficient_project_access"
  | "member_not_found"
  | "personal_project_access"
  | "workspace_owner_access"
  | "session_required"
  | "self_dependency"
  | "cross_project_dependency"
  | "dependency_cycle"
  | "assignee_not_found";

const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  project_not_found: "This project does not exist.",
  issue_not_found: "This issue does not exist.",
  issue_link_not_found: "This link does not exist on the issue.",
  issue_link_exists: "This URL is already attached to the issue.",
  knowledge_entry_not_found: "This knowledge entry does not exist.",
  project_creation_not_allowed: "You do not have Create projects in this workspace.",
  insufficient_project_access: "This project access level cannot do that.",
  member_not_found: "This person is not a member of the workspace.",
  personal_project_access: "Personal projects have no direct collaborators.",
  workspace_owner_access: "Workspace owners already have Manage access to every project.",
  session_required: "This agent holds no live work session for this issue.",
  self_dependency: "An issue cannot block itself.",
  cross_project_dependency: "Dependencies can only link issues in the same project.",
  dependency_cycle: "That dependency would create a cycle.",
  assignee_not_found: "No active member or registered agent in this workspace has that id.",
} as const satisfies Record<ProjectsErrorKind, string>;

const ACCESS_RANK: Record<ProjectAccessLevel, number> = {
  read: 1,
  contribute: 2,
  manage: 3,
};

// What a project query learns about the caller's access. A shared workspace row has a
// membership (isOwner false or true) or none (null); a personal row has an owner id.
type AccessFacts = {
  workspaceKind: WorkspaceKind;
  personalOwnerHumanId: string | null;
  membershipIsOwner: boolean | null;
  grantLevel: ProjectAccessLevel | null;
};

// The one resolver: personal owner or shared owner -> Manage; a shared member -> their
// explicit grant; anyone else -> none. A grant without a live membership is stale and
// grants nothing (removal deletes it too, so a rejoin starts fresh).
function resolveAccessLevel(facts: AccessFacts, humanId: string): ProjectAccessLevel | null {
  if (facts.workspaceKind === WorkspaceKind.enum.personal) {
    return facts.personalOwnerHumanId === humanId ? ProjectAccessLevel.enum.manage : null;
  }
  if (facts.membershipIsOwner === null) return null;
  if (facts.membershipIsOwner) return ProjectAccessLevel.enum.manage;
  return facts.grantLevel;
}

// The agent-key ceiling: the human's current access to each named project in a
// workspace, decided by the same resolver as every human-facing endpoint. A project
// outside the workspace, or a human with no current access, answers null. This is the
// one policy path for project levels; agents borrow it instead of growing a second one.
export async function projectAccessCeilingInTransaction(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
): Promise<Map<string, ProjectAccessLevel | null>> {
  const ceiling = new Map<string, ProjectAccessLevel | null>();
  if (projectIds.length === 0) return ceiling;

  const [workspace] = await tx
    .select({
      kind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
    })
    .from(workspaces)
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),
        // A suspended membership (#38) grants no access, even if an old grant row survived.
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  for (const projectId of projectIds) {
    if (workspace === undefined) {
      ceiling.set(projectId, null);
      continue;
    }
    const [row] = await tx
      .select({ workspaceId: projects.workspaceId, grantLevel: projectAccessGrants.level })
      .from(projects)
      .leftJoin(
        projectAccessGrants,
        and(
          eq(projectAccessGrants.projectId, projects.id),
          eq(projectAccessGrants.humanId, humanId),
        ),
      )
      .where(eq(projects.id, projectId))
      .limit(1);
    if (row === undefined || row.workspaceId !== workspaceId) {
      ceiling.set(projectId, null);
      continue;
    }
    ceiling.set(
      projectId,
      resolveAccessLevel(
        {
          workspaceKind: WorkspaceKind.parse(workspace.kind),
          personalOwnerHumanId: workspace.personalOwnerHumanId,
          membershipIsOwner: workspace.membershipIsOwner,
          grantLevel: row.grantLevel === null ? null : ProjectAccessLevel.parse(row.grantLevel),
        },
        humanId,
      ),
    );
  }
  return ceiling;
}

// The one level comparison, shared with features that borrow this policy (agent keys).
export function projectAccessAtLeast(
  actual: ProjectAccessLevel,
  required: ProjectAccessLevel,
): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

// The actor's effective level for one project. A human's level comes from the same
// workspace/grant resolver as every REST route. An agent's level is the key's effective
// grant (already capped by its owner's current access at authentication) and nothing
// else. An agent cannot see a project outside its key's one workspace: that answers just
// like a missing project, so an out-of-scope id reveals nothing.
function actorAccessLevel(
  facts: AccessFacts & { projectId: string; workspaceId: string },
  actor: WorkActor,
): ProjectAccessLevel | null {
  if (actor.kind === "human") return resolveAccessLevel(facts, actor.account.humanId);
  if (facts.workspaceId !== actor.identity.workspaceId) return null;
  return (
    actor.identity.projects.find((grant) => grant.projectId === facts.projectId)?.level ?? null
  );
}

function requireLevel(
  facts: AccessFacts & { projectId: string; workspaceId: string },
  actor: WorkActor,
  required: ProjectAccessLevel,
  missingKind: ProjectsErrorKind,
): ProjectAccessLevel {
  const level = actorAccessLevel(facts, actor);
  if (level === null) throw new ProjectsError(missingKind);
  if (!projectAccessAtLeast(level, required)) {
    throw new ProjectsError("insufficient_project_access");
  }
  return level;
}

export class ProjectsError extends Error {
  readonly kind: ProjectsErrorKind;

  constructor(kind: ProjectsErrorKind) {
    super(messages[kind]);
    this.name = "ProjectsError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new ProjectsError("not_signed_in");
  return account;
}

// Human project work and agent project work share one policy path. A human acts with
// their own session; an agent acts with the identity its key resolved, including the key's
// effective project levels. Both are decided only here, never by a transport adapter.
export type WorkActor =
  | { kind: "human"; account: SessionAccount }
  | { kind: "agent"; identity: AgentIdentity };

function requireActor(actor: WorkActor | null): WorkActor {
  if (actor === null) throw new ProjectsError("not_signed_in");
  return actor;
}

function humanIdOf(actor: WorkActor): string | null {
  return actor.kind === "human" ? actor.account.humanId : null;
}

function agentIdOf(actor: WorkActor): string | null {
  return actor.kind === "agent" ? actor.identity.agentId : null;
}

// An agent has no human id to join on. Use a false predicate rather than a made-up
// sentinel id, so an agent query cannot accidentally match a row.
function humanIdMatch(actor: WorkActor, table: "membership" | "grant") {
  const humanId = humanIdOf(actor);
  if (humanId === null) return sql`false`;
  const column =
    table === "membership" ? workspaceMemberships.humanId : projectAccessGrants.humanId;
  // A suspended membership is present but grants nothing (#38). The grant predicate stays
  // a plain equality; deactivation deletes the grants, and re-invitation recreates them.
  return table === "membership"
    ? and(eq(column, humanId), isNull(workspaceMemberships.suspendedAt))
    : eq(column, humanId);
}

// The display actor for a write: the human's email or the agent's name. An agent action
// never carries its owner's human id or email, so history cannot misattribute it.
function actorForWrite(actor: WorkActor): Actor {
  if (actor.kind === "human") {
    return {
      humanId: actor.account.humanId,
      email: actor.account.email,
      displayName: actor.account.email,
    };
  }
  return {
    agentId: actor.identity.agentId,
    agentName: actor.identity.name,
    displayName: actor.identity.name,
  };
}

// The display actor for a stored row: exactly one of the human or agent columns is set.
// A deactivated human still has a row and a stable email label; `deactivated` marks it
// suspended rather than dropping the author and showing "unknown" (#38).
function actorFromRow(
  humanId: string | null,
  email: string | null,
  agentId: string | null,
  agentName: string | null,
  deactivatedAt: Date | null = null,
): Actor {
  if (humanId !== null && email !== null) {
    const deactivated = deactivatedAt !== null;
    return {
      humanId,
      email,
      displayName: deactivated ? `${email} (deactivated)` : email,
      ...(deactivated ? { deactivated: true } : {}),
    };
  }
  if (agentId !== null && agentName !== null) {
    return { agentId, agentName, displayName: agentName };
  }
  // The actor constraint guarantees one identity. A missing human row is corruption, not
  // deactivation (deactivation keeps the identity), so keep a readable, non-blaming label.
  return { displayName: "Unknown author" };
}

// The assignee's display identity. The database CHECK guarantees the type and id agree;
// a missing joined row means the identity was removed after assignment, so the badge
// disappears rather than inventing a name. A deactivated assignee keeps its label.
function assigneeFromRow(row: {
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  assigneeHumanEmail: string | null;
  assigneeHumanDeactivatedAt: Date | null;
  assigneeAgentName: string | null;
}): Actor | null {
  if (row.assigneeType === "human" && row.assigneeId !== null && row.assigneeHumanEmail !== null) {
    return actorFromRow(
      row.assigneeId,
      row.assigneeHumanEmail,
      null,
      null,
      row.assigneeHumanDeactivatedAt,
    );
  }
  if (row.assigneeType === "agent" && row.assigneeId !== null && row.assigneeAgentName !== null) {
    return actorFromRow(null, null, row.assigneeId, row.assigneeAgentName);
  }
  return null;
}

// Aliases let one query join humans several times: a creator and a last editor, or an
// issue's author and a comment's author. Each alias is a separate SQL name.
const projectCreator = alias(humans, "project_creator");
const issueCreator = alias(humans, "issue_creator");
const issueEditor = alias(humans, "issue_editor");
const commentAuthor = alias(humans, "comment_author");
const linkCreator = alias(humans, "link_creator");
const knowledgeCreator = alias(humans, "knowledge_creator");
const knowledgeEditor = alias(humans, "knowledge_editor");
const activityActor = alias(humans, "activity_actor");
const accessGrantor = alias(humans, "access_grantor");
// Agent aliases mirror the human aliases above; a row's actor column decides which one
// carries the identity. Left joins keep agent-authored rows in the same query.
const issueAgentCreator = alias(agents, "issue_agent_creator");
const issueAgentEditor = alias(agents, "issue_agent_editor");
// #84: assignment is displayed with the same Actor shape as authorship, so the row's
// assignee_type decides which of these two aliases carries display information.
const assigneeHuman = alias(humans, "assignee_human");
const assigneeAgent = alias(agents, "assignee_agent");
const commentAgentAuthor = alias(agents, "comment_agent_author");
const linkAgentCreator = alias(agents, "link_agent_creator");
const knowledgeAgentCreator = alias(agents, "knowledge_agent_creator");
const knowledgeAgentEditor = alias(agents, "knowledge_agent_editor");
const activityAgentActor = alias(agents, "activity_agent_actor");
// A dependency edge keeps who added it; both aliases are needed to render that actor.
const dependencyHumanCreator = alias(humans, "dependency_human_creator");
const dependencyAgentCreator = alias(agents, "dependency_agent_creator");

const projectColumns = {
  id: projects.id,
  workspaceId: projects.workspaceId,
  name: projects.name,
  createdAt: projects.createdAt,
  createdByHumanId: projects.createdByHumanId,
  createdByEmail: projectCreator.email,
  createdByDeactivatedAt: projectCreator.deactivatedAt,
  fallbackPolicy: projects.fallbackPolicy,
};

// One deterministic board/ready-work order (#88): importance, position, then creation.
// The CASE ranks the contract enum explicitly because the text values are not in that
// order lexicographically. Once assignees exist (#84), assigned-to-caller sorts ahead of
// this list; until then this is the whole queue order.
const issuePriorityRank = sql`case ${issues.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;
const issueBoardOrder = [
  issuePriorityRank,
  asc(issues.sortOrder),
  asc(issues.createdAt),
  asc(issues.number),
];

const issueColumns = {
  id: issues.id,
  projectId: issues.projectId,
  number: issues.number,
  title: issues.title,
  body: issues.body,
  status: issues.status,
  priority: issues.priority,
  sortOrder: issues.sortOrder,
  needsInput: issues.needsInput,
  assigneeType: issues.assigneeType,
  assigneeId: issues.assigneeId,
  assigneeHumanEmail: assigneeHuman.email,
  assigneeHumanDeactivatedAt: assigneeHuman.deactivatedAt,
  assigneeAgentName: assigneeAgent.name,
  fallbackPolicyOverride: issues.fallbackPolicyOverride,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
  closedAt: issues.closedAt,
  createdByHumanId: issues.createdByHumanId,
  createdByEmail: issueCreator.email,
  createdByDeactivatedAt: issueCreator.deactivatedAt,
  createdByAgentId: issues.createdByAgentId,
  createdByAgentName: issueAgentCreator.name,
  updatedByHumanId: issues.updatedByHumanId,
  updatedByEmail: issueEditor.email,
  updatedByDeactivatedAt: issueEditor.deactivatedAt,
  updatedByAgentId: issues.updatedByAgentId,
  updatedByAgentName: issueAgentEditor.name,
};

const commentColumns = {
  id: issueComments.id,
  issueId: issueComments.issueId,
  body: issueComments.body,
  createdAt: issueComments.createdAt,
  authorHumanId: issueComments.createdByHumanId,
  authorEmail: commentAuthor.email,
  authorDeactivatedAt: commentAuthor.deactivatedAt,
  authorAgentId: issueComments.createdByAgentId,
  authorAgentName: commentAgentAuthor.name,
};

const linkColumns = {
  id: issueLinks.id,
  issueId: issueLinks.issueId,
  url: issueLinks.url,
  title: issueLinks.title,
  kind: issueLinks.kind,
  createdAt: issueLinks.createdAt,
  createdByHumanId: issueLinks.createdByHumanId,
  createdByEmail: linkCreator.email,
  createdByDeactivatedAt: linkCreator.deactivatedAt,
  createdByAgentId: issueLinks.createdByAgentId,
  createdByAgentName: linkAgentCreator.name,
};

const knowledgeColumns = {
  id: knowledgeEntries.id,
  projectId: knowledgeEntries.projectId,
  title: knowledgeEntries.title,
  body: knowledgeEntries.body,
  createdAt: knowledgeEntries.createdAt,
  updatedAt: knowledgeEntries.updatedAt,
  createdByHumanId: knowledgeEntries.createdByHumanId,
  createdByEmail: knowledgeCreator.email,
  createdByDeactivatedAt: knowledgeCreator.deactivatedAt,
  createdByAgentId: knowledgeEntries.createdByAgentId,
  createdByAgentName: knowledgeAgentCreator.name,
  updatedByHumanId: knowledgeEntries.updatedByHumanId,
  updatedByEmail: knowledgeEditor.email,
  updatedByDeactivatedAt: knowledgeEditor.deactivatedAt,
  updatedByAgentId: knowledgeEntries.updatedByAgentId,
  updatedByAgentName: knowledgeAgentEditor.name,
};

const dependencyColumns = {
  issueId: issueDependencies.issueId,
  blockedByIssueId: issueDependencies.blockedByIssueId,
  createdAt: issueDependencies.createdAt,
  createdByHumanId: issueDependencies.createdByHumanId,
  createdByEmail: dependencyHumanCreator.email,
  createdByDeactivatedAt: dependencyHumanCreator.deactivatedAt,
  createdByAgentId: issueDependencies.createdByAgentId,
  createdByAgentName: dependencyAgentCreator.name,
};

const activityColumns = {
  id: projectActivity.id,
  projectId: projectActivity.projectId,
  type: projectActivity.type,
  summary: projectActivity.summary,
  issueId: projectActivity.issueId,
  knowledgeEntryId: projectActivity.knowledgeEntryId,
  createdAt: projectActivity.createdAt,
  actorHumanId: projectActivity.actorHumanId,
  actorEmail: activityActor.email,
  actorDeactivatedAt: activityActor.deactivatedAt,
  actorAgentId: projectActivity.actorAgentId,
  actorAgentName: activityAgentActor.name,
};

type ProjectRow = {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: Date;
  createdByHumanId: string;
  createdByEmail: string;
  createdByDeactivatedAt: Date | null;
  workspaceKind: WorkspaceKind;
  accessLevel: ProjectAccessLevel;
  fallbackPolicy: FallbackPolicy;
};

type ProjectGrantRow = {
  humanId: string;
  email: string;
  level: ProjectAccessLevel;
  grantedByHumanId: string;
  grantedByEmail: string;
  grantedByDeactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type IssueRow = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  sortOrder: number;
  needsInput: boolean;
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  assigneeHumanEmail: string | null;
  assigneeHumanDeactivatedAt: Date | null;
  assigneeAgentName: string | null;
  fallbackPolicyOverride: FallbackPolicy | null;
  // The project's policy, joined by requireIssue so a single DTO carries the resolved one.
  projectFallbackPolicy: FallbackPolicy;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
  updatedByHumanId: string | null;
  updatedByEmail: string | null;
  updatedByDeactivatedAt: Date | null;
  updatedByAgentId: string | null;
  updatedByAgentName: string | null;
};

type IssueDependencyRow = {
  issueId: string;
  blockedByIssueId: string;
  createdAt: Date;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
};

type CommentRow = {
  id: string;
  issueId: string;
  body: string;
  createdAt: Date;
  authorHumanId: string | null;
  authorEmail: string | null;
  authorDeactivatedAt: Date | null;
  authorAgentId: string | null;
  authorAgentName: string | null;
};

type LinkRow = {
  id: string;
  issueId: string;
  url: string;
  title: string;
  kind: IssueLinkKind;
  createdAt: Date;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
};

type KnowledgeRow = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
  updatedByHumanId: string | null;
  updatedByEmail: string | null;
  updatedByDeactivatedAt: Date | null;
  updatedByAgentId: string | null;
  updatedByAgentName: string | null;
};

type ActivityRow = {
  id: string;
  projectId: string;
  type: ProjectActivityType;
  summary: string;
  issueId: string | null;
  knowledgeEntryId: string | null;
  createdAt: Date;
  actorHumanId: string | null;
  actorEmail: string | null;
  actorDeactivatedAt: Date | null;
  actorAgentId: string | null;
  actorAgentName: string | null;
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      null,
      null,
      row.createdByDeactivatedAt,
    ),
    workspaceKind: row.workspaceKind,
    accessLevel: row.accessLevel,
    fallbackPolicy: row.fallbackPolicy,
  };
}

function toProjectGrant(row: ProjectGrantRow): ProjectAccessGrant {
  return {
    humanId: row.humanId,
    email: row.email,
    level: row.level,
    grantedBy: actorFromRow(
      row.grantedByHumanId,
      row.grantedByEmail,
      null,
      null,
      row.grantedByDeactivatedAt,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    sortOrder: row.sortOrder,
    needsInput: row.needsInput,
    assignee: assigneeFromRow(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    fallbackPolicyOverride: row.fallbackPolicyOverride,
    effectiveFallbackPolicy: row.fallbackPolicyOverride ?? row.projectFallbackPolicy,
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
    ),
    updatedBy: actorFromRow(
      row.updatedByHumanId,
      row.updatedByEmail,
      row.updatedByAgentId,
      row.updatedByAgentName,
      row.updatedByDeactivatedAt,
    ),
  };
}

function toIssueDependency(row: IssueDependencyRow): IssueDependency {
  return {
    issueId: row.issueId,
    blockedByIssueId: row.blockedByIssueId,
    createdAt: row.createdAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
    ),
  };
}

function toComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issueId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    author: actorFromRow(
      row.authorHumanId,
      row.authorEmail,
      row.authorAgentId,
      row.authorAgentName,
      row.authorDeactivatedAt,
    ),
  };
}

function toLink(row: LinkRow): IssueLink {
  return {
    id: row.id,
    issueId: row.issueId,
    url: row.url,
    title: row.title,
    kind: IssueLinkKind.parse(row.kind),
    createdAt: row.createdAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
    ),
  };
}

// The links on an issue, newest last. The detail read is the one place that loads them,
// so order and author display come from a single query.
async function loadIssueLinks(tx: DbTransaction, issueId: string): Promise<IssueLink[]> {
  const rows = await tx
    .select(linkColumns)
    .from(issueLinks)
    .leftJoin(linkCreator, eq(linkCreator.id, issueLinks.createdByHumanId))
    .leftJoin(linkAgentCreator, eq(linkAgentCreator.id, issueLinks.createdByAgentId))
    .where(eq(issueLinks.issueId, issueId))
    .orderBy(issueLinks.createdAt, issueLinks.id);
  return rows.map(toLink);
}

function toKnowledge(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
    ),
    updatedBy: actorFromRow(
      row.updatedByHumanId,
      row.updatedByEmail,
      row.updatedByAgentId,
      row.updatedByAgentName,
      row.updatedByDeactivatedAt,
    ),
  };
}

function toActivity(row: ActivityRow): ProjectActivity {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    summary: row.summary,
    issueId: row.issueId,
    knowledgeEntryId: row.knowledgeEntryId,
    createdAt: row.createdAt.toISOString(),
    actor: actorFromRow(
      row.actorHumanId,
      row.actorEmail,
      row.actorAgentId,
      row.actorAgentName,
      row.actorDeactivatedAt,
    ),
  };
}

type WorkspaceFacts = {
  id: string;
  kind: WorkspaceKind;
  name: string;
  isOwner: boolean;
  canCreateProjects: boolean;
};

// The caller's workspace access, in one query. Personal access is ownership; shared
// access is a membership. A workspace outside the caller's access answers exactly like
// a missing one, so workspace ids cannot be enumerated.
async function readWorkspaceFacts(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<WorkspaceFacts> {
  const [row] = await tx
    .select({
      id: workspaces.id,
      kind: workspaces.kind,
      name: workspaces.name,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      membershipCanCreateProjects: workspaceMemberships.canCreateProjects,
    })
    .from(workspaces)
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),
        // A suspended membership (#38) grants no access, even if an old grant row survived.
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("workspace_not_found");

  if (row.kind === WorkspaceKind.enum.personal) {
    if (row.personalOwnerHumanId !== humanId) throw new ProjectsError("workspace_not_found");
    return { ...row, isOwner: true, canCreateProjects: true };
  }

  if (row.membershipIsOwner === null) throw new ProjectsError("workspace_not_found");
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isOwner: row.membershipIsOwner,
    canCreateProjects: row.membershipIsOwner || row.membershipCanCreateProjects === true,
  };
}

// The project and the caller's effective access to it, in one query. No access answers
// exactly like a missing project; a level below the requirement answers 403, because
// the caller can already see that the project exists.
async function requireProject(
  tx: DbTransaction,
  projectId: string,
  actor: WorkActor,
  required: ProjectAccessLevel,
) {
  // The human joins still run for an agent (with an id that matches nothing); the agent's
  // level comes from its key, so a human grant can never leak into an agent's decision.
  const membershipMatch = humanIdMatch(actor, "membership");
  const grantMatch = humanIdMatch(actor, "grant");
  const [row] = await tx
    .select({
      ...projectColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
    })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(projectCreator, eq(projectCreator.id, projects.createdByHumanId))
    .leftJoin(
      workspaceMemberships,
      and(eq(workspaceMemberships.workspaceId, projects.workspaceId), membershipMatch),
    )
    .leftJoin(projectAccessGrants, and(eq(projectAccessGrants.projectId, projects.id), grantMatch))
    .where(eq(projects.id, projectId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("project_not_found");
  const grantLevel = row.grantLevel === null ? null : ProjectAccessLevel.parse(row.grantLevel);
  const facts = {
    workspaceKind: WorkspaceKind.parse(row.workspaceKind),
    personalOwnerHumanId: row.personalOwnerHumanId,
    membershipIsOwner: row.membershipIsOwner,
    grantLevel,
    projectId: row.id,
    workspaceId: row.workspaceId,
  };
  return {
    ...row,
    ...facts,
    accessLevel: requireLevel(facts, actor, required, "project_not_found"),
  };
}

async function requireIssue(
  tx: DbTransaction,
  issueId: string,
  actor: WorkActor,
  required: ProjectAccessLevel,
) {
  const membershipMatch = humanIdMatch(actor, "membership");
  const grantMatch = humanIdMatch(actor, "grant");
  const [row] = await tx
    .select({
      ...issueColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
      workspaceId: projects.workspaceId,
      projectFallbackPolicy: projects.fallbackPolicy,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .leftJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
    .leftJoin(issueAgentCreator, eq(issueAgentCreator.id, issues.createdByAgentId))
    .leftJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
    .leftJoin(issueAgentEditor, eq(issueAgentEditor.id, issues.updatedByAgentId))
    .leftJoin(
      assigneeHuman,
      and(eq(assigneeHuman.id, issues.assigneeId), eq(issues.assigneeType, "human")),
    )
    .leftJoin(
      assigneeAgent,
      and(eq(assigneeAgent.id, issues.assigneeId), eq(issues.assigneeType, "agent")),
    )
    .leftJoin(
      workspaceMemberships,
      and(eq(workspaceMemberships.workspaceId, projects.workspaceId), membershipMatch),
    )
    .leftJoin(projectAccessGrants, and(eq(projectAccessGrants.projectId, projects.id), grantMatch))
    .where(eq(issues.id, issueId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("issue_not_found");
  return { ...row, accessLevel: requireLevel(row, actor, required, "issue_not_found") };
}

// #84: resolve and validate an assignee in the caller's transaction. The locks are taken
// in Orrery's shared M22 order — account (KEY SHARE), membership (KEY SHARE) — BEFORE the
// caller locks the issue, so a deactivation or member removal that commits first is seen
// here and one in flight waits rather than deadlocking. Human and agent callers both use
// this one decision; a missing, deactivated, suspended or unregistered identity answers
// the same 404 instead of revealing which check failed.
async function validateAssignee(
  tx: DbTransaction,
  workspaceId: string,
  assignee: Assignee,
): Promise<Actor> {
  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (workspace === undefined) throw new ProjectsError("assignee_not_found");

  let targetHumanId: string;
  let resolved: Actor;
  if (assignee.type === "human") {
    const [human] = await tx
      .select({ id: humans.id, email: humans.email })
      .from(humans)
      .where(and(eq(humans.id, assignee.id), isNull(humans.deactivatedAt)))
      .limit(1)
      .for("key share");
    if (human === undefined) throw new ProjectsError("assignee_not_found");
    targetHumanId = human.id;
    resolved = { humanId: human.id, email: human.email, displayName: human.email };
  } else {
    const [agent] = await tx
      .select({ id: agents.id, humanId: agents.humanId, name: agents.name })
      .from(agents)
      .where(eq(agents.id, assignee.id))
      .limit(1);
    if (agent === undefined) throw new ProjectsError("assignee_not_found");
    // An agent is registered in this workspace while a live key scoped to it exists.
    const [key] = await tx
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(
        and(
          eq(agentApiKeys.agentId, agent.id),
          eq(agentApiKeys.workspaceId, workspaceId),
          isNull(agentApiKeys.revokedAt),
          or(
            isNull(agentApiKeys.expiresAt),
            gt(agentApiKeys.expiresAt, sql`statement_timestamp()`),
          ),
        ),
      )
      .limit(1);
    if (key === undefined) throw new ProjectsError("assignee_not_found");
    const [owner] = await tx
      .select({ id: humans.id })
      .from(humans)
      .where(and(eq(humans.id, agent.humanId), isNull(humans.deactivatedAt)))
      .limit(1)
      .for("key share");
    if (owner === undefined) throw new ProjectsError("assignee_not_found");
    targetHumanId = agent.humanId;
    resolved = { agentId: agent.id, agentName: agent.name, displayName: agent.name };
  }

  // A personal workspace's owner needs no membership; a shared workspace needs a live
  // membership for the target human, whichever kind of identity is being assigned.
  if (workspace.personalOwnerHumanId !== targetHumanId) {
    const [membership] = await tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, targetHumanId),
          isNull(workspaceMemberships.suspendedAt),
        ),
      )
      .limit(1)
      .for("key share");
    if (membership === undefined) throw new ProjectsError("assignee_not_found");
  }
  return resolved;
}

async function requireKnowledge(
  tx: DbTransaction,
  entryId: string,
  actor: WorkActor,
  required: ProjectAccessLevel,
) {
  const membershipMatch = humanIdMatch(actor, "membership");
  const grantMatch = humanIdMatch(actor, "grant");
  const [row] = await tx
    .select({
      ...knowledgeColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
      workspaceId: projects.workspaceId,
    })
    .from(knowledgeEntries)
    .innerJoin(projects, eq(projects.id, knowledgeEntries.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .leftJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
    .leftJoin(
      knowledgeAgentCreator,
      eq(knowledgeAgentCreator.id, knowledgeEntries.createdByAgentId),
    )
    .leftJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
    .leftJoin(knowledgeAgentEditor, eq(knowledgeAgentEditor.id, knowledgeEntries.updatedByAgentId))
    .leftJoin(
      workspaceMemberships,
      and(eq(workspaceMemberships.workspaceId, projects.workspaceId), membershipMatch),
    )
    .leftJoin(projectAccessGrants, and(eq(projectAccessGrants.projectId, projects.id), grantMatch))
    .where(eq(knowledgeEntries.id, entryId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("knowledge_entry_not_found");
  return { ...row, accessLevel: requireLevel(row, actor, required, "knowledge_entry_not_found") };
}

type RecordActivityInput =
  | {
      projectId: string;
      type: "project_created" | "project_renamed" | "project_fallback_policy_changed";
      actor: WorkActor;
      summary: string;
    }
  | {
      projectId: string;
      type:
        | "issue_created"
        | "issue_edited"
        | "issue_commented"
        | "issue_closed"
        | "issue_reopened"
        | "issue_fallback_policy_override_changed"
        | "issue_dependency_added"
        | "issue_dependency_removed"
        | "issue_link_added"
        | "issue_link_removed";
      actor: WorkActor;
      summary: string;
      issueId: string;
    }
  | {
      projectId: string;
      type: "knowledge_created" | "knowledge_edited";
      actor: WorkActor;
      summary: string;
      knowledgeEntryId: string;
    };

// One activity event, written inside the caller's transaction so the change and its
// history commit together or not at all. The summary is the item's title at this moment.
// The actor identity is the human or the agent — never both, never the agent's owner.
async function recordActivity(tx: DbTransaction, input: RecordActivityInput) {
  await tx.insert(projectActivity).values({
    id: randomUUID(),
    projectId: input.projectId,
    type: input.type,
    actorHumanId: humanIdOf(input.actor),
    actorAgentId: agentIdOf(input.actor),
    summary: input.summary,
    createdAt: sql`statement_timestamp()`,
    ...("issueId" in input ? { issueId: input.issueId } : {}),
    ...("knowledgeEntryId" in input ? { knowledgeEntryId: input.knowledgeEntryId } : {}),
  });
}

// One project access-change event, written in the grant's transaction so the row and its
// history commit together. The event names the stable human ids, never emails or secrets.
async function recordAccessEvent(
  tx: DbTransaction,
  input: {
    projectId: string;
    // #46: the workspace that owned the project when the change happened. Every event
    // carries its own scope so a later transfer cannot make old grants readable elsewhere.
    workspaceId: string;
    actorHumanId: string;
    subjectHumanId: string;
    type: ProjectAccessEventType;
    level: ProjectAccessLevel | null;
    previousLevel: ProjectAccessLevel | null;
  },
) {
  await tx.insert(projectAccessEvents).values({
    id: randomUUID(),
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    actorHumanId: input.actorHumanId,
    subjectHumanId: input.subjectHumanId,
    type: input.type,
    level: input.level,
    previousLevel: input.previousLevel,
    createdAt: sql`statement_timestamp()`,
  });
}

// A membership removal ends every project grant it carried in that workspace, in the
// removing transaction. The workspace feature calls this through the projects feature's
// public interface; the revocation events keep the attribution.
async function revokeMemberProjectAccessInTransaction(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  actorHumanId: string,
) {
  const grants = await tx
    .select({
      id: projectAccessGrants.id,
      projectId: projectAccessGrants.projectId,
      level: projectAccessGrants.level,
    })
    .from(projectAccessGrants)
    .innerJoin(projects, eq(projects.id, projectAccessGrants.projectId))
    .where(and(eq(projects.workspaceId, workspaceId), eq(projectAccessGrants.humanId, humanId)));

  if (grants.length === 0) return;

  await tx.delete(projectAccessGrants).where(
    inArray(
      projectAccessGrants.id,
      grants.map((grant) => grant.id),
    ),
  );
  for (const grant of grants) {
    await recordAccessEvent(tx, {
      projectId: grant.projectId,
      workspaceId,
      actorHumanId,
      subjectHumanId: humanId,
      type: ProjectAccessEventType.enum.project_access_revoked,
      level: null,
      previousLevel: ProjectAccessLevel.parse(grant.level),
    });
  }
}

// Apply the project grants offered by a workspace invitation. The invitation feature
// has already consumed the token in this transaction; this method first proves every
// offered project still belongs to the invited workspace, then writes the grants and
// their access events. A missing/moved project returns its id without writing anything,
// so the caller can reject the whole redemption and leave the token pending.
async function applyInvitationGrantsInTransaction(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  grantedByHumanId: string,
  offered: readonly { projectId: string; level: ProjectAccessLevel }[],
): Promise<string[]> {
  if (offered.length === 0) return [];

  await lockWorkspaceOwnershipWrites(tx);
  const projectIds = [...new Set(offered.map((grant) => grant.projectId))];
  const currentProjects = await tx
    .select({ id: projects.id, workspaceId: projects.workspaceId })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const currentWorkspaceByProject = new Map(
    currentProjects.map((project) => [project.id, project.workspaceId]),
  );
  const invalid = projectIds.filter(
    (projectId) => currentWorkspaceByProject.get(projectId) !== workspaceId,
  );
  if (invalid.length > 0) return invalid;

  for (const offer of offered) {
    const [current] = await tx
      .select({ level: projectAccessGrants.level })
      .from(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.projectId, offer.projectId),
          eq(projectAccessGrants.humanId, humanId),
        ),
      )
      .limit(1);
    const currentLevel = current === undefined ? null : ProjectAccessLevel.parse(current.level);
    // A previous higher grant is not silently lowered by an invitation; otherwise the
    // offered level is the deliberate scope. Repeating the same offer is a no-op.
    const nextLevel =
      currentLevel === null || ACCESS_RANK[offer.level] > ACCESS_RANK[currentLevel]
        ? offer.level
        : currentLevel;
    if (nextLevel === currentLevel) continue;

    await tx
      .insert(projectAccessGrants)
      .values({
        id: randomUUID(),
        projectId: offer.projectId,
        humanId,
        level: nextLevel,
        grantedByHumanId,
        createdAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      })
      .onConflictDoUpdate({
        target: [projectAccessGrants.projectId, projectAccessGrants.humanId],
        set: {
          level: nextLevel,
          grantedByHumanId,
          updatedAt: sql`statement_timestamp()`,
        },
      });
    await recordAccessEvent(tx, {
      projectId: offer.projectId,
      workspaceId,
      actorHumanId: grantedByHumanId,
      subjectHumanId: humanId,
      type:
        currentLevel === null
          ? ProjectAccessEventType.enum.project_access_granted
          : ProjectAccessEventType.enum.project_access_level_changed,
      level: nextLevel,
      previousLevel: currentLevel,
    });
  }
  return [];
}

async function lockWorkspaceOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function lockProjectForMutation(tx: DbTransaction, projectId: string) {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
}

const grantColumns = {
  humanId: projectAccessGrants.humanId,
  email: humans.email,
  level: projectAccessGrants.level,
  grantedByHumanId: projectAccessGrants.grantedByHumanId,
  grantedByEmail: accessGrantor.email,
  grantedByDeactivatedAt: accessGrantor.deactivatedAt,
  createdAt: projectAccessGrants.createdAt,
  updatedAt: projectAccessGrants.updatedAt,
};

async function readProjectGrant(tx: DbTransaction, projectId: string, humanId: string) {
  const [row] = await tx
    .select(grantColumns)
    .from(projectAccessGrants)
    .innerJoin(humans, eq(humans.id, projectAccessGrants.humanId))
    .innerJoin(accessGrantor, eq(accessGrantor.id, projectAccessGrants.grantedByHumanId))
    .where(
      and(eq(projectAccessGrants.projectId, projectId), eq(projectAccessGrants.humanId, humanId)),
    )
    .limit(1);
  return row;
}

// The work-sessions feature's narrow seam for fenced agent writes. It lazily expires a
// stale lease inside the caller's already issue-locked transaction and answers whether the
// agent holds a live session. Project edits never claim on the agent's behalf: a stale
// write is refused, not turned into a fresh claim.
export type WorkSessionGate = (
  tx: DbTransaction,
  agentId: string,
  workspaceId: string,
  issueId: string,
) => Promise<boolean>;

export interface ProjectsDeps {
  db: PostgresJsDatabase;
  sessionGate: WorkSessionGate;
  // The inbox's deadline evaluation on the caller's already locked transaction. Optional
  // for standalone construction; the feature registry wires it in production. A policy
  // change calls it first so an already-due question cannot be re-projected under a new
  // policy after its outcome was effectively decided.
  evaluateQuestionDeadline?: ((tx: DbTransaction, issueId: string) => Promise<void>) | undefined;
}

// Materialize every already-due question on the affected issues before their policy can
// change. Issues are locked in id order, like every other deadline writer, so a concurrent
// answer or check-in cannot write-skew past this freeze. Never opens a nested transaction.
async function freezeDueQuestions(
  tx: DbTransaction,
  issueIds: readonly string[],
  evaluateQuestionDeadline: ProjectsDeps["evaluateQuestionDeadline"],
): Promise<void> {
  if (evaluateQuestionDeadline === undefined || issueIds.length === 0) return;
  const ids = [...new Set(issueIds)].toSorted();
  await tx
    .select({ id: issues.id })
    .from(issues)
    .where(inArray(issues.id, ids))
    .orderBy(issues.id)
    .for("update");
  for (const id of ids) await evaluateQuestionDeadline(tx, id);
}

export interface ProjectsService {
  listProjects(actor: WorkActor | null, workspaceId: string): Promise<Project[]>;
  getProject(actor: WorkActor | null, projectId: string): Promise<Project>;
  createProject(
    account: SessionAccount | null,
    workspaceId: string,
    input: CreateProjectRequest,
  ): Promise<Project>;
  updateProject(
    account: SessionAccount | null,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<Project>;
  listProjectAccess(
    account: SessionAccount | null,
    projectId: string,
  ): Promise<ProjectAccessGrant[]>;
  setProjectAccess(
    account: SessionAccount | null,
    projectId: string,
    input: SetProjectAccessRequest,
  ): Promise<ProjectAccessGrant>;
  // #42: human-session-only policy settings. An agent key is never passed here, so it
  // cannot authorize its own fallback; both decisions are made in this service.
  setProjectFallbackPolicy(
    account: SessionAccount | null,
    projectId: string,
    input: SetProjectFallbackPolicyRequest,
  ): Promise<Project>;
  setIssueFallbackPolicyOverride(
    account: SessionAccount | null,
    issueId: string,
    input: SetIssueFallbackPolicyRequest,
  ): Promise<Issue>;
  removeProjectAccess(
    account: SessionAccount | null,
    projectId: string,
    humanId: string,
  ): Promise<void>;
  // The workspace feature's membership removal calls this inside its transaction.
  revokeMemberProjectAccess(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
  ): Promise<void>;
  // The workspace invitation redemption calls this inside its transaction. It returns
  // the ids of offered projects that no longer belong to the workspace.
  applyInvitationGrants(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    grantedByHumanId: string,
    offered: readonly { projectId: string; level: ProjectAccessLevel }[],
  ): Promise<string[]>;
  // The agents feature borrows this for the dynamic human-access ceiling on a key.
  projectAccessCeiling(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    projectIds: readonly string[],
  ): Promise<Map<string, ProjectAccessLevel | null>>;
  listIssues(actor: WorkActor | null, projectId: string): Promise<Issue[]>;
  getIssue(actor: WorkActor | null, issueId: string): Promise<IssueDetail>;
  createIssue(
    actor: WorkActor | null,
    projectId: string,
    input: CreateIssueRequest,
  ): Promise<Issue>;
  updateIssue(actor: WorkActor | null, issueId: string, input: UpdateIssueRequest): Promise<Issue>;
  // Directed blocked_by edges (#86). Modifying an edge needs Contribute; either direction
  // can be listed with Read. Both issues must be in the same project.
  addBlockedBy(
    actor: WorkActor | null,
    issueId: string,
    input: AddBlockedByRequest,
  ): Promise<IssueDependency>;
  removeBlockedBy(
    actor: WorkActor | null,
    issueId: string,
    blockedByIssueId: string,
  ): Promise<void>;
  listBlockedBy(actor: WorkActor | null, issueId: string): Promise<Issue[]>;
  listBlocking(actor: WorkActor | null, issueId: string): Promise<Issue[]>;
  listComments(actor: WorkActor | null, issueId: string): Promise<IssueComment[]>;
  createComment(
    actor: WorkActor | null,
    issueId: string,
    input: CreateIssueCommentRequest,
  ): Promise<IssueComment>;
  addIssueLink(
    actor: WorkActor | null,
    issueId: string,
    input: CreateIssueLinkRequest,
  ): Promise<IssueLink>;
  removeIssueLink(actor: WorkActor | null, issueId: string, linkId: string): Promise<void>;
  listActivity(actor: WorkActor | null, projectId: string): Promise<ProjectActivity[]>;
  listKnowledge(actor: WorkActor | null, projectId: string): Promise<KnowledgeEntry[]>;
  getKnowledge(actor: WorkActor | null, entryId: string): Promise<KnowledgeEntry>;
  createKnowledge(
    actor: WorkActor | null,
    projectId: string,
    input: CreateKnowledgeEntryRequest,
  ): Promise<KnowledgeEntry>;
  updateKnowledge(
    actor: WorkActor | null,
    entryId: string,
    input: UpdateKnowledgeEntryRequest,
  ): Promise<KnowledgeEntry>;
}

export function createProjectsService({
  db,
  sessionGate,
  evaluateQuestionDeadline,
}: ProjectsDeps): ProjectsService {
  // The one issue listing, borrowed by the blocked_by readers so a relation resolves to the
  // same Issue shape every other listing returns. Dependency edges live in one project, so
  // listing by that project and selecting the related ids keeps both reads in one place.
  async function readIssues(actor: WorkActor, projectId: string): Promise<Issue[]> {
    return db.transaction(
      async (tx) => {
        await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read);
        const rows = await tx
          .select({ ...issueColumns, projectFallbackPolicy: projects.fallbackPolicy })
          .from(issues)
          .innerJoin(projects, eq(projects.id, issues.projectId))
          .leftJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
          .leftJoin(issueAgentCreator, eq(issueAgentCreator.id, issues.createdByAgentId))
          .leftJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
          .leftJoin(issueAgentEditor, eq(issueAgentEditor.id, issues.updatedByAgentId))
          .leftJoin(
            assigneeHuman,
            and(eq(assigneeHuman.id, issues.assigneeId), eq(issues.assigneeType, "human")),
          )
          .leftJoin(
            assigneeAgent,
            and(eq(assigneeAgent.id, issues.assigneeId), eq(issues.assigneeType, "agent")),
          )
          .where(eq(issues.projectId, projectId))
          .orderBy(...issueBoardOrder);
        return rows.map(toIssue);
      },
      { accessMode: "read only" },
    );
  }
  return {
    // The listing is the caller's accessible projects in the workspace: all of a personal
    // workspace's own projects, all of a shared workspace's projects for an owner, and
    // only explicitly granted projects for an ordinary member. Membership validates the
    // workspace; it does not reveal the projects themselves.
    async listProjects(actorArg, workspaceId) {
      const actor = requireActor(actorArg);
      // A key is scoped to one workspace. Refuse another workspace id before any lookup:
      // answering empty for a workspace the owner happens to belong to would both bypass
      // the scope and leak the owner's membership through a 200-vs-404 oracle.
      if (actor.kind === "agent" && workspaceId !== actor.identity.workspaceId) {
        throw new ProjectsError("workspace_not_found");
      }
      return db.transaction(
        async (tx) => {
          // The key's human owner is whose workspace membership is checked; the
          // project levels still come from the key, not from that membership's grants.
          const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;
          const workspace = await readWorkspaceFacts(tx, workspaceId, humanId);
          const rows = await tx
            .select({
              ...projectColumns,
              workspaceKind: workspaces.kind,
              personalOwnerHumanId: workspaces.personalOwnerHumanId,
              membershipIsOwner: workspaceMemberships.isOwner,
              grantLevel: projectAccessGrants.level,
            })
            .from(projects)
            .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
            .innerJoin(projectCreator, eq(projectCreator.id, projects.createdByHumanId))
            .leftJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, projects.workspaceId),
                eq(workspaceMemberships.humanId, humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            )
            .leftJoin(
              projectAccessGrants,
              and(
                eq(projectAccessGrants.projectId, projects.id),
                eq(projectAccessGrants.humanId, humanId),
              ),
            )
            .where(
              workspace.kind === WorkspaceKind.enum.personal
                ? eq(projects.workspaceId, workspaceId)
                : workspace.isOwner
                  ? eq(projects.workspaceId, workspaceId)
                  : and(
                      eq(projects.workspaceId, workspaceId),
                      isNotNull(projectAccessGrants.level),
                    ),
            )
            .orderBy(projects.createdAt, projects.id);

          return rows.flatMap((row) => {
            const facts = { ...row, projectId: row.id, workspaceId: row.workspaceId };
            const accessLevel = actorAccessLevel(facts, actor);
            return accessLevel === null ? [] : [toProject({ ...row, accessLevel })];
          });
        },
        { accessMode: "read only" },
      );
    },

    async getProject(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) =>
          toProject(await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read)),
        { accessMode: "read only" },
      );
    },

    // The creator is recorded, and the workspace keeps the project: the creator does not
    // become a second owner. A personal owner or a shared owner can always create; a
    // shared member needs the Create projects capability. A member who creates a project
    // receives an explicit Manage grant in the same transaction, so their access is real
    // and revocable rather than inferred from creation.
    async createProject(account, workspaceId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      const id = randomUUID();
      return db.transaction(async (tx) => {
        // Serialize with workspace membership/capability mutations so a removed member
        // or revoked capability cannot commit a project with an orphaned Manage grant.
        await lockWorkspaceOwnershipWrites(tx);
        const workspace = await readWorkspaceFacts(tx, workspaceId, actor.humanId);
        if (!workspace.canCreateProjects) {
          throw new ProjectsError("project_creation_not_allowed");
        }
        const [created] = await tx
          .insert(projects)
          .values({
            id,
            workspaceId,
            name: input.name,
            createdByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
          })
          .returning({
            id: projects.id,
            workspaceId: projects.workspaceId,
            name: projects.name,
            createdAt: projects.createdAt,
          });
        if (created === undefined) throw new Error("the project was not created");

        if (workspace.kind === WorkspaceKind.enum.shared && !workspace.isOwner) {
          await tx.insert(projectAccessGrants).values({
            id: randomUUID(),
            projectId: id,
            humanId: actor.humanId,
            level: ProjectAccessLevel.enum.manage,
            grantedByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          });
          await recordAccessEvent(tx, {
            projectId: id,
            workspaceId,
            actorHumanId: actor.humanId,
            subjectHumanId: actor.humanId,
            type: ProjectAccessEventType.enum.project_access_granted,
            level: ProjectAccessLevel.enum.manage,
            previousLevel: null,
          });
        }

        await recordActivity(tx, {
          projectId: id,
          type: "project_created",
          actor: workActor,
          summary: input.name,
        });
        return {
          id: created.id,
          workspaceId: created.workspaceId,
          name: created.name,
          createdAt: created.createdAt.toISOString(),
          createdBy: { humanId: actor.humanId, email: actor.email, displayName: actor.email },
          workspaceKind: workspace.kind,
          accessLevel: ProjectAccessLevel.enum.manage,
          fallbackPolicy: FallbackPolicy.enum.require_human,
        };
      });
    },

    // Manage may rename the project. A no-op keeps the project and its activity
    // unchanged, so a repeated save cannot invent history.
    async updateProject(account, projectId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        // Lock first, then authorize: a concurrent grant change cannot slip between the
        // access check and the rename.
        await lockProjectForMutation(tx, projectId);
        const current = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );
        if (input.name === current.name) return toProject(current);
        const [updated] = await tx
          .update(projects)
          .set({ name: input.name })
          .where(eq(projects.id, projectId))
          .returning({ name: projects.name, createdAt: projects.createdAt });
        if (updated === undefined) throw new ProjectsError("project_not_found");
        await recordActivity(tx, {
          projectId,
          type: "project_renamed",
          actor: workActor,
          summary: updated.name,
        });
        return toProject({ ...current, name: updated.name });
      });
    },

    // The project-wide fallback policy (#42). Only a human with Manage may set it; the
    // row lock serializes a change against an answer or deadline evaluation reading it.
    // A no-op records no activity, like a repeated rename.
    async setProjectFallbackPolicy(account, projectId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        await lockProjectForMutation(tx, projectId);
        const current = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );
        // A question already past its deadline resolves under the *old* policy before it
        // can be re-projected under the new one; otherwise a fallback_used answer could
        // visually flip back to paused just because a manager changed the setting.
        const due = await tx
          .select({ issueId: questions.issueId })
          .from(questions)
          .innerJoin(issues, eq(issues.id, questions.issueId))
          .where(
            and(
              eq(issues.projectId, projectId),
              eq(questions.status, "open"),
              lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
            ),
          )
          .orderBy(issues.id);
        await freezeDueQuestions(
          tx,
          due.map((row) => row.issueId),
          evaluateQuestionDeadline,
        );
        if (current.fallbackPolicy === input.fallbackPolicy) return toProject(current);
        const [updated] = await tx
          .update(projects)
          .set({ fallbackPolicy: input.fallbackPolicy })
          .where(eq(projects.id, projectId))
          .returning({ fallbackPolicy: projects.fallbackPolicy });
        if (updated === undefined) throw new ProjectsError("project_not_found");
        await recordActivity(tx, {
          projectId,
          type: "project_fallback_policy_changed",
          actor: workActor,
          summary: `Fallback policy changed to ${updated.fallbackPolicy}`,
        });
        return toProject({ ...current, fallbackPolicy: updated.fallbackPolicy });
      });
    },

    // An issue override may only tighten the policy without Manage. Loosening — an
    // explicit fallback_allowed override, or clearing a require_human override under a
    // fallback_allowed project — needs Manage. Effective policy is override ?? project;
    // neither this write nor the fallback it authorizes changes any project access.
    async setIssueFallbackPolicyOverride(account, issueId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
        const current = await requireIssue(
          tx,
          issueId,
          workActor,
          ProjectAccessLevel.enum.contribute,
        );
        // The issue row is already locked: resolve a due question before its policy can
        // change, so the recorded outcome cannot be reinterpreted by the override write.
        await evaluateQuestionDeadline?.(tx, issueId);
        const override = input.override;
        const currentEffective = current.fallbackPolicyOverride ?? current.projectFallbackPolicy;
        const nextEffective = override ?? current.projectFallbackPolicy;
        const loosens =
          override === FallbackPolicy.enum.fallback_allowed ||
          (nextEffective === FallbackPolicy.enum.fallback_allowed &&
            currentEffective === FallbackPolicy.enum.require_human);
        if (loosens && !projectAccessAtLeast(current.accessLevel, ProjectAccessLevel.enum.manage)) {
          throw new ProjectsError("insufficient_project_access");
        }
        if (current.fallbackPolicyOverride === override) return toIssue(current);
        const [updated] = await tx
          .update(issues)
          .set({
            fallbackPolicyOverride: override,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(issues.id, issueId))
          .returning({ fallbackPolicyOverride: issues.fallbackPolicyOverride });
        if (updated === undefined) throw new ProjectsError("issue_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_fallback_policy_override_changed",
          actor: workActor,
          issueId,
          summary: `Fallback policy override ${override === null ? "cleared" : `set to ${override}`}`,
        });
        return toIssue({ ...current, fallbackPolicyOverride: updated.fallbackPolicyOverride });
      });
    },

    // The explicit grants a project manager sees. Workspace owners are not listed because
    // their Manage is implicit (including members later promoted to owner); a personal
    // project has no collaborators at all.
    async listProjectAccess(account, projectId) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(
        async (tx) => {
          const project = await requireProject(
            tx,
            projectId,
            workActor,
            ProjectAccessLevel.enum.manage,
          );
          if (project.workspaceKind === WorkspaceKind.enum.personal) return [];
          const rows = await tx
            .select(grantColumns)
            .from(projectAccessGrants)
            .innerJoin(humans, eq(humans.id, projectAccessGrants.humanId))
            .innerJoin(accessGrantor, eq(accessGrantor.id, projectAccessGrants.grantedByHumanId))
            .innerJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, project.workspaceId),
                eq(workspaceMemberships.humanId, projectAccessGrants.humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            )
            .where(
              and(
                eq(projectAccessGrants.projectId, projectId),
                eq(workspaceMemberships.isOwner, false),
              ),
            )
            .orderBy(projectAccessGrants.createdAt, projectAccessGrants.humanId);
          return rows.map(toProjectGrant);
        },
        { accessMode: "read only" },
      );
    },

    // Manage grants or changes one member's level. The project row lock serializes
    // concurrent grant changes; the unique pair keeps one row per person, and every real
    // change writes one attributed event. Personal projects refuse collaborators, and
    // workspace owners already hold implicit Manage that project managers cannot alter.
    async setProjectAccess(account, projectId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        // Lock workspace membership writes before the project row so granting access
        // cannot race with removeMember() (orphaning a grant) or appointOwner().
        await lockWorkspaceOwnershipWrites(tx);
        await lockProjectForMutation(tx, projectId);
        const project = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );
        if (project.workspaceKind === WorkspaceKind.enum.personal) {
          throw new ProjectsError("personal_project_access");
        }

        const [target] = await tx
          .select({
            humanId: humans.id,
            email: humans.email,
            isOwner: workspaceMemberships.isOwner,
          })
          .from(workspaceMemberships)
          .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
          .where(
            and(
              eq(workspaceMemberships.workspaceId, project.workspaceId),
              eq(humans.email, input.email),
              isNull(workspaceMemberships.suspendedAt),
              isNull(humans.deactivatedAt),
            ),
          )
          .limit(1);
        if (target === undefined) throw new ProjectsError("member_not_found");
        if (target.isOwner) throw new ProjectsError("workspace_owner_access");

        const [current] = await tx
          .select({ level: projectAccessGrants.level })
          .from(projectAccessGrants)
          .where(
            and(
              eq(projectAccessGrants.projectId, projectId),
              eq(projectAccessGrants.humanId, target.humanId),
            ),
          )
          .limit(1);

        if (current?.level === input.level) {
          const existing = await readProjectGrant(tx, projectId, target.humanId);
          if (existing === undefined) throw new Error("the access grant disappeared");
          return toProjectGrant(existing);
        }

        await tx
          .insert(projectAccessGrants)
          .values({
            id: randomUUID(),
            projectId,
            humanId: target.humanId,
            level: input.level,
            grantedByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .onConflictDoUpdate({
            target: [projectAccessGrants.projectId, projectAccessGrants.humanId],
            set: {
              level: input.level,
              grantedByHumanId: actor.humanId,
              updatedAt: sql`statement_timestamp()`,
            },
          });

        await recordAccessEvent(tx, {
          projectId,
          workspaceId: project.workspaceId,
          actorHumanId: actor.humanId,
          subjectHumanId: target.humanId,
          type:
            current === undefined
              ? ProjectAccessEventType.enum.project_access_granted
              : ProjectAccessEventType.enum.project_access_level_changed,
          level: input.level,
          previousLevel: current === undefined ? null : ProjectAccessLevel.parse(current.level),
        });

        const saved = await readProjectGrant(tx, projectId, target.humanId);
        if (saved === undefined) throw new Error("the access grant was not saved");
        return toProjectGrant(saved);
      });
    },

    // Revoking is idempotent: the desired state is "no grant", and a missing grant is
    // already there. A real revocation is recorded with its previous level. Workspace
    // owners cannot have their implicit Manage revoked here.
    async removeProjectAccess(account, projectId, humanId) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      await db.transaction(async (tx) => {
        // Lock workspace membership writes before the project row so revoking access
        // cannot race with removeMember() and emit duplicate revocation events.
        await lockWorkspaceOwnershipWrites(tx);
        await lockProjectForMutation(tx, projectId);
        const project = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );
        if (project.workspaceKind === WorkspaceKind.enum.personal) {
          throw new ProjectsError("personal_project_access");
        }

        const [targetMembership] = await tx
          .select({ isOwner: workspaceMemberships.isOwner })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, project.workspaceId),
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
            ),
          )
          .limit(1);
        if (targetMembership?.isOwner === true) {
          throw new ProjectsError("workspace_owner_access");
        }

        const [current] = await tx
          .select({ level: projectAccessGrants.level })
          .from(projectAccessGrants)
          .where(
            and(
              eq(projectAccessGrants.projectId, projectId),
              eq(projectAccessGrants.humanId, humanId),
            ),
          )
          .limit(1);
        if (current === undefined) return;

        await tx
          .delete(projectAccessGrants)
          .where(
            and(
              eq(projectAccessGrants.projectId, projectId),
              eq(projectAccessGrants.humanId, humanId),
            ),
          );
        await recordAccessEvent(tx, {
          projectId,
          workspaceId: project.workspaceId,
          actorHumanId: actor.humanId,
          subjectHumanId: humanId,
          type: ProjectAccessEventType.enum.project_access_revoked,
          level: null,
          previousLevel: ProjectAccessLevel.parse(current.level),
        });
      });
    },

    revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId) {
      return revokeMemberProjectAccessInTransaction(tx, workspaceId, humanId, actorHumanId);
    },

    applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered) {
      return applyInvitationGrantsInTransaction(
        tx,
        workspaceId,
        humanId,
        grantedByHumanId,
        offered,
      );
    },

    projectAccessCeiling(tx, workspaceId, humanId, projectIds) {
      return projectAccessCeilingInTransaction(tx, workspaceId, humanId, projectIds);
    },

    async listIssues(actorArg, projectId) {
      return readIssues(requireActor(actorArg), projectId);
    },

    async getIssue(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          return { ...toIssue(issue), links: await loadIssueLinks(tx, issueId) };
        },
        { accessMode: "read only" },
      );
    },

    // The project row is updated before the issue is inserted: the row lock serializes
    // concurrent creations, and the returned value is the number this issue takes.
    async createIssue(actorArg, projectId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        const project = await requireProject(
          tx,
          projectId,
          actor,
          ProjectAccessLevel.enum.contribute,
        );
        const [counter] = await tx
          .update(projects)
          .set({ nextIssueNumber: sql`${projects.nextIssueNumber} + 1` })
          .where(eq(projects.id, projectId))
          .returning({ number: sql<number>`${projects.nextIssueNumber} - 1` });
        if (counter === undefined) throw new ProjectsError("project_not_found");

        const id = randomUUID();
        const [created] = await tx
          .insert(issues)
          .values({
            id,
            projectId,
            number: counter.number,
            title: input.title,
            body: input.body ?? "",
            status: IssueStatus.enum.open,
            priority: input.priority ?? IssuePriority.enum.none,
            sortOrder: input.sortOrder ?? counter.number * ISSUE_SORT_STEP,
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .returning({
            id: issues.id,
            projectId: issues.projectId,
            number: issues.number,
            title: issues.title,
            body: issues.body,
            status: issues.status,
            priority: issues.priority,
            sortOrder: issues.sortOrder,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
            closedAt: issues.closedAt,
          });
        if (created === undefined) throw new Error("the issue was not created");
        await recordActivity(tx, {
          projectId,
          type: "issue_created",
          actor,
          issueId: id,
          summary: input.title,
        });
        const author = actorForWrite(actor);
        return {
          id: created.id,
          projectId: created.projectId,
          number: created.number,
          title: created.title,
          body: created.body,
          status: IssueStatus.parse(created.status),
          priority: created.priority,
          sortOrder: created.sortOrder,
          needsInput: false,
          assignee: null,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          closedAt: created.closedAt === null ? null : created.closedAt.toISOString(),
          createdBy: author,
          updatedBy: author,
          fallbackPolicyOverride: null,
          effectiveFallbackPolicy: project.fallbackPolicy,
        };
      });
    },

    // A title or body edit, a close, and a reopen are all this one transition. Only real
    // changes update the issue and write activity; a no-op answers with the issue as it
    // was, so a repeated close cannot invent a second event.
    async updateIssue(actorArg, issueId, input) {
      const actor = requireActor(actorArg);
      // Authorize and resolve the workspace in a read first, so an inaccessible issue
      // answers 404 before any assignee probe and no lock is held during that lookup.
      const target = await db.transaction(
        async (tx) => {
          const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
          return { workspaceId: issue.workspaceId };
        },
        { accessMode: "read only" },
      );
      return db.transaction(async (tx) => {
        // #84: account/membership KEY SHARE locks for assignment validation come BEFORE
        // the issue lock below, matching claim and deactivation's M22 lock order.
        const resolvedAssignee =
          input.assignee === undefined || input.assignee === null
            ? null
            : await validateAssignee(tx, target.workspaceId, input.assignee);
        // Serialize concurrent updates to the same issue so two PATCHes cannot lose
        // each other's changes or diverge the activity feed from the issue's status.
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
        const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        // #84: the access precheck and the assignee validation ran in separate committed
        // transactions. A project transfer that committed between them may have moved the
        // issue to another workspace; recheck under the issue lock so a source-workspace
        // assignee can never be written onto a transferred issue.
        if (
          input.assignee !== undefined &&
          input.assignee !== null &&
          current.workspaceId !== target.workspaceId
        ) {
          throw new ProjectsError("issue_not_found");
        }
        // #20 fences an agent's issue state/body edits (including close and reopen) on a
        // live session it holds. Humans, comments, creation and knowledge stay unfenced.
        // The gate runs after access and under the same issue row lock, so a downgrade to
        // Read and an expired lease both refuse the write in this one transaction.
        if (
          actor.kind === "agent" &&
          !(await sessionGate(tx, actor.identity.agentId, actor.identity.workspaceId, issueId))
        ) {
          throw new ProjectsError("session_required");
        }
        const title = input.title ?? current.title;
        const body = input.body ?? current.body;
        const status = input.status ?? current.status;
        const priority = input.priority ?? current.priority;
        const sortOrder = input.sortOrder ?? current.sortOrder;
        // An omitted assignee leaves it unchanged; an explicit null clears the pair.
        const assigneeType =
          input.assignee === undefined ? current.assigneeType : (input.assignee?.type ?? null);
        const assigneeId =
          input.assignee === undefined ? current.assigneeId : (input.assignee?.id ?? null);
        const titleChanged = title !== current.title;
        const bodyChanged = body !== current.body;
        const statusChanged = status !== current.status;
        const priorityChanged = priority !== current.priority;
        const orderChanged = sortOrder !== current.sortOrder;
        const assigneeChanged =
          assigneeType !== current.assigneeType || assigneeId !== current.assigneeId;
        if (
          !titleChanged &&
          !bodyChanged &&
          !statusChanged &&
          !priorityChanged &&
          !orderChanged &&
          !assigneeChanged
        ) {
          return toIssue(current);
        }

        const closedAt =
          status === IssueStatus.enum.closed
            ? current.status === IssueStatus.enum.closed
              ? current.closedAt
              : sql`statement_timestamp()`
            : null;
        const [updated] = await tx
          .update(issues)
          .set({
            title,
            body,
            status,
            priority,
            sortOrder,
            assigneeType,
            assigneeId,
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            updatedAt: sql`statement_timestamp()`,
            closedAt,
          })
          .where(eq(issues.id, issueId))
          .returning({
            updatedAt: issues.updatedAt,
            closedAt: issues.closedAt,
          });
        if (updated === undefined) throw new ProjectsError("issue_not_found");

        // A priority change is a real edit and is recorded. A reorder is not: dragging a
        // card writes only its midpoint, and an activity event per drag would drown the
        // feed, so sortOrder updates stay invisible there (the issue's updatedAt still moves).
        if (titleChanged || bodyChanged || priorityChanged || assigneeChanged) {
          await recordActivity(tx, {
            projectId: current.projectId,
            type: "issue_edited",
            actor,
            issueId,
            summary: title,
          });
        }
        if (statusChanged) {
          await recordActivity(tx, {
            projectId: current.projectId,
            type: status === IssueStatus.enum.closed ? "issue_closed" : "issue_reopened",
            actor,
            issueId,
            summary: title,
          });
        }
        return {
          id: current.id,
          projectId: current.projectId,
          number: current.number,
          title,
          body,
          status: IssueStatus.parse(status),
          priority,
          sortOrder,
          needsInput: current.needsInput,
          assignee: assigneeChanged
            ? input.assignee === null
              ? null
              : resolvedAssignee
            : assigneeFromRow(current),
          createdAt: current.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          closedAt: updated.closedAt === null ? null : updated.closedAt.toISOString(),
          createdBy: actorFromRow(
            current.createdByHumanId,
            current.createdByEmail,
            current.createdByAgentId,
            current.createdByAgentName,
          ),
          updatedBy: actorForWrite(actor),
          fallbackPolicyOverride: current.fallbackPolicyOverride,
          effectiveFallbackPolicy: current.fallbackPolicyOverride ?? current.projectFallbackPolicy,
        };
      });
    },

    // An edge is added under a lock on both issue rows so two writers cannot race past
    // the acyclicity check (A blocked by B while B is blocked by A). Locking in id order
    // keeps concurrent writers from deadlocking on the pair.
    async addBlockedBy(actorArg, issueId, input) {
      const actor = requireActor(actorArg);
      const blockedByIssueId = input.blockedByIssueId;
      return db.transaction(async (tx) => {
        const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        if (issueId === blockedByIssueId) throw new ProjectsError("self_dependency");
        const blocker = await requireIssue(
          tx,
          blockedByIssueId,
          actor,
          ProjectAccessLevel.enum.read,
        );
        if (blocker.projectId !== current.projectId) {
          throw new ProjectsError("cross_project_dependency");
        }

        // Lock the parent project row FIRST (matching Orrery's global projects -> issues
        // lock order shared with transfers M21/M24 so concurrent transfer + dependency
        // writes cannot AB-BA deadlock), then lock the two endpoint issues in id order.
        // Serializing on the project row also closes the >=4-node concurrent cycle race.
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, current.projectId))
          .for("update");

        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(inArray(issues.id, [issueId, blockedByIssueId].toSorted()))
          .orderBy(issues.id)
          .for("update");

        // Re-adding an edge is a no-op: the unique constraint stays the database's final
        // word, and a repeated agent call must not invent a second activity event.
        const [existing] = await tx
          .select(dependencyColumns)
          .from(issueDependencies)
          .leftJoin(
            dependencyHumanCreator,
            eq(dependencyHumanCreator.id, issueDependencies.createdByHumanId),
          )
          .leftJoin(
            dependencyAgentCreator,
            eq(dependencyAgentCreator.id, issueDependencies.createdByAgentId),
          )
          .where(
            and(
              eq(issueDependencies.issueId, issueId),
              eq(issueDependencies.blockedByIssueId, blockedByIssueId),
            ),
          )
          .limit(1);
        if (existing !== undefined) return toIssueDependency(existing);

        // Walk forward from the new blocker. Reaching the issue being blocked means the
        // new edge would close a cycle. Bounded by the project's graph; the project row is
        // locked for the whole check-and-insert, so no concurrent add can race past it.
        const visited = new Set<string>([blockedByIssueId]);
        let frontier: string[] = [blockedByIssueId];
        while (frontier.length > 0) {
          const rows = await tx
            .select({ next: issueDependencies.blockedByIssueId })
            .from(issueDependencies)
            .where(inArray(issueDependencies.issueId, frontier));
          const next: string[] = [];
          for (const row of rows) {
            if (row.next === issueId) throw new ProjectsError("dependency_cycle");
            if (!visited.has(row.next)) {
              visited.add(row.next);
              next.push(row.next);
            }
          }
          frontier = next;
        }

        const [inserted] = await tx
          .insert(issueDependencies)
          .values({
            id: randomUUID(),
            issueId,
            blockedByIssueId,
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
          })
          .returning({ createdAt: issueDependencies.createdAt });
        if (inserted === undefined) throw new Error("the dependency was not created");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_dependency_added",
          actor,
          issueId,
          summary: `${current.title} blocked by ${blocker.title}`,
        });
        return {
          issueId,
          blockedByIssueId,
          createdAt: inserted.createdAt.toISOString(),
          createdBy: actorForWrite(actor),
        };
      });
    },

    // Removing a relation that is not there is a no-op, so a repeated UI click or agent
    // retry cannot fail or write a spurious activity event.
    async removeBlockedBy(actorArg, issueId, blockedByIssueId) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const [blocker] = await tx
          .select({ title: issues.title })
          .from(issues)
          .where(eq(issues.id, blockedByIssueId))
          .limit(1);
        const deleted = await tx
          .delete(issueDependencies)
          .where(
            and(
              eq(issueDependencies.issueId, issueId),
              eq(issueDependencies.blockedByIssueId, blockedByIssueId),
            ),
          )
          .returning({ issueId: issueDependencies.issueId });
        if (deleted.length === 0) return;
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_dependency_removed",
          actor,
          issueId,
          summary: `${current.title} no longer blocked by ${blocker?.title ?? blockedByIssueId}`,
        });
      });
    },

    async listBlockedBy(actorArg, issueId) {
      const actor = requireActor(actorArg);
      const found = await db.transaction(
        async (tx) => {
          const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select({ id: issueDependencies.blockedByIssueId })
            .from(issueDependencies)
            .where(eq(issueDependencies.issueId, issueId));
          return { projectId: current.projectId, ids: rows.map((row) => row.id) };
        },
        { accessMode: "read only" },
      );
      if (found.ids.length === 0) return [];
      const blockers = new Set(found.ids);
      return (await readIssues(actor, found.projectId)).filter((issue) => blockers.has(issue.id));
    },

    async listBlocking(actorArg, issueId) {
      const actor = requireActor(actorArg);
      const found = await db.transaction(
        async (tx) => {
          const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select({ id: issueDependencies.issueId })
            .from(issueDependencies)
            .where(eq(issueDependencies.blockedByIssueId, issueId));
          return { projectId: current.projectId, ids: rows.map((row) => row.id) };
        },
        { accessMode: "read only" },
      );
      if (found.ids.length === 0) return [];
      const dependants = new Set(found.ids);
      return (await readIssues(actor, found.projectId)).filter((issue) => dependants.has(issue.id));
    },

    async listComments(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(commentColumns)
            .from(issueComments)
            .leftJoin(commentAuthor, eq(commentAuthor.id, issueComments.createdByHumanId))
            .leftJoin(commentAgentAuthor, eq(commentAgentAuthor.id, issueComments.createdByAgentId))
            .where(eq(issueComments.issueId, issueId))
            .orderBy(issueComments.createdAt, issueComments.id);
          return rows.map(toComment);
        },
        { accessMode: "read only" },
      );
    },

    // Comments need no work session (#20); they still need project access, which
    // requireIssue enforces, and they keep their author.
    async createComment(actorArg, issueId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const id = randomUUID();
        const [created] = await tx
          .insert(issueComments)
          .values({
            id,
            issueId,
            body: input.body,
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
          })
          .returning({
            id: issueComments.id,
            issueId: issueComments.issueId,
            body: issueComments.body,
            createdAt: issueComments.createdAt,
          });
        if (created === undefined) throw new Error("the comment was not created");
        await recordActivity(tx, {
          projectId: issue.projectId,
          type: "issue_commented",
          actor,
          issueId,
          summary: issue.title,
        });
        return {
          id: created.id,
          issueId: created.issueId,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          author: actorForWrite(actor),
        };
      });
    },

    // Links need no work session, just like comments (#20). Contribute is enough; the
    // unique index makes a repeated (issue, url) a clean 409 instead of a second row.
    async addIssueLink(actorArg, issueId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        let created:
          | {
              id: string;
              issueId: string;
              url: string;
              title: string;
              kind: IssueLinkKind;
              createdAt: Date;
            }
          | undefined;
        try {
          [created] = await tx
            .insert(issueLinks)
            .values({
              id: randomUUID(),
              issueId,
              url: input.url,
              title: input.title,
              kind: input.kind,
              createdByHumanId: humanIdOf(actor),
              createdByAgentId: agentIdOf(actor),
              createdAt: sql`statement_timestamp()`,
            })
            .returning({
              id: issueLinks.id,
              issueId: issueLinks.issueId,
              url: issueLinks.url,
              title: issueLinks.title,
              kind: issueLinks.kind,
              createdAt: issueLinks.createdAt,
            });
        } catch (error) {
          if (uniqueConstraintName(error) === "one_link_per_issue_and_url") {
            throw new ProjectsError("issue_link_exists");
          }
          throw error;
        }
        if (created === undefined) throw new Error("the link was not created");
        await recordActivity(tx, {
          projectId: issue.projectId,
          type: "issue_link_added",
          actor,
          issueId,
          summary: `${issue.title} — ${input.title}`,
        });
        return {
          id: created.id,
          issueId: created.issueId,
          url: created.url,
          title: created.title,
          kind: IssueLinkKind.parse(created.kind),
          createdAt: created.createdAt.toISOString(),
          createdBy: actorForWrite(actor),
        };
      });
    },

    async removeIssueLink(actorArg, issueId, linkId) {
      const actor = requireActor(actorArg);
      await db.transaction(async (tx) => {
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const [removed] = await tx
          .delete(issueLinks)
          .where(and(eq(issueLinks.id, linkId), eq(issueLinks.issueId, issueId)))
          .returning({ title: issueLinks.title });
        if (removed === undefined) throw new ProjectsError("issue_link_not_found");
        await recordActivity(tx, {
          projectId: issue.projectId,
          type: "issue_link_removed",
          actor,
          issueId,
          summary: `${issue.title} — ${removed.title}`,
        });
      });
    },

    async listActivity(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(activityColumns)
            .from(projectActivity)
            .leftJoin(activityActor, eq(activityActor.id, projectActivity.actorHumanId))
            .leftJoin(activityAgentActor, eq(activityAgentActor.id, projectActivity.actorAgentId))
            .where(eq(projectActivity.projectId, projectId))
            .orderBy(projectActivity.createdAt, projectActivity.id);
          return rows.map(toActivity);
        },
        { accessMode: "read only" },
      );
    },

    async listKnowledge(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(knowledgeColumns)
            .from(knowledgeEntries)
            .leftJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
            .leftJoin(
              knowledgeAgentCreator,
              eq(knowledgeAgentCreator.id, knowledgeEntries.createdByAgentId),
            )
            .leftJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
            .leftJoin(
              knowledgeAgentEditor,
              eq(knowledgeAgentEditor.id, knowledgeEntries.updatedByAgentId),
            )
            .where(eq(knowledgeEntries.projectId, projectId))
            .orderBy(knowledgeEntries.createdAt, knowledgeEntries.id);
          return rows.map(toKnowledge);
        },
        { accessMode: "read only" },
      );
    },

    async getKnowledge(actorArg, entryId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) =>
          toKnowledge(await requireKnowledge(tx, entryId, actor, ProjectAccessLevel.enum.read)),
        { accessMode: "read only" },
      );
    },

    async createKnowledge(actorArg, projectId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.contribute);
        const id = randomUUID();
        const [created] = await tx
          .insert(knowledgeEntries)
          .values({
            id,
            projectId,
            title: input.title,
            body: input.body ?? "",
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .returning({
            id: knowledgeEntries.id,
            projectId: knowledgeEntries.projectId,
            title: knowledgeEntries.title,
            body: knowledgeEntries.body,
            createdAt: knowledgeEntries.createdAt,
            updatedAt: knowledgeEntries.updatedAt,
          });
        if (created === undefined) throw new Error("the knowledge entry was not created");
        await recordActivity(tx, {
          projectId,
          type: "knowledge_created",
          actor,
          knowledgeEntryId: id,
          summary: input.title,
        });
        const author = actorForWrite(actor);
        return {
          id: created.id,
          projectId: created.projectId,
          title: created.title,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          createdBy: author,
          updatedBy: author,
        };
      });
    },

    async updateKnowledge(actorArg, entryId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        // Serialize concurrent edits to the same knowledge entry so partial PATCHes
        // never overwrite each other's changes.
        await tx
          .select({ id: knowledgeEntries.id })
          .from(knowledgeEntries)
          .where(eq(knowledgeEntries.id, entryId))
          .for("update");
        const current = await requireKnowledge(
          tx,
          entryId,
          actor,
          ProjectAccessLevel.enum.contribute,
        );
        const title = input.title ?? current.title;
        const body = input.body ?? current.body;
        if (title === current.title && body === current.body) return toKnowledge(current);
        const [updated] = await tx
          .update(knowledgeEntries)
          .set({
            title,
            body,
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(knowledgeEntries.id, entryId))
          .returning({ updatedAt: knowledgeEntries.updatedAt });
        if (updated === undefined) throw new ProjectsError("knowledge_entry_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "knowledge_edited",
          actor,
          knowledgeEntryId: entryId,
          summary: title,
        });
        return {
          id: current.id,
          projectId: current.projectId,
          title,
          body,
          createdAt: current.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          createdBy: actorFromRow(
            current.createdByHumanId,
            current.createdByEmail,
            current.createdByAgentId,
            current.createdByAgentName,
          ),
          updatedBy: actorForWrite(actor),
        };
      });
    },
  };
}
