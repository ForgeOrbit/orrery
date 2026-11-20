import { randomUUID } from "node:crypto";
import {
  IssueStatus,
  ProjectAccessEventType,
  ProjectAccessLevel,
  WorkspaceKind,
  type CreateIssueCommentRequest,
  type CreateIssueRequest,
  type CreateKnowledgeEntryRequest,
  type CreateProjectRequest,
  type Issue,
  type IssueComment,
  type KnowledgeEntry,
  type Project,
  type ProjectAccessGrant,
  type ProjectActivity,
  type ProjectActivityType,
  type SetProjectAccessRequest,
  type UpdateIssueRequest,
  type UpdateKnowledgeEntryRequest,
  type UpdateProjectRequest,
} from "@orrery/contract";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  humans,
  issueComments,
  issues,
  knowledgeEntries,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projects,
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
  | "knowledge_entry_not_found"
  | "project_creation_not_allowed"
  | "insufficient_project_access"
  | "member_not_found"
  | "personal_project_access"
  | "workspace_owner_access";

const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  project_not_found: "This project does not exist.",
  issue_not_found: "This issue does not exist.",
  knowledge_entry_not_found: "This knowledge entry does not exist.",
  project_creation_not_allowed: "You do not have Create projects in this workspace.",
  insufficient_project_access: "This project access level cannot do that.",
  member_not_found: "This person is not a member of the workspace.",
  personal_project_access: "Personal projects have no direct collaborators.",
  workspace_owner_access: "Workspace owners already have Manage access to every project.",
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

function requireLevel(
  facts: AccessFacts,
  humanId: string,
  required: ProjectAccessLevel,
  missingKind: ProjectsErrorKind,
): ProjectAccessLevel {
  const level = resolveAccessLevel(facts, humanId);
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

// Aliases let one query join humans several times: a creator and a last editor, or an
// issue's author and a comment's author. Each alias is a separate SQL name.
const projectCreator = alias(humans, "project_creator");
const issueCreator = alias(humans, "issue_creator");
const issueEditor = alias(humans, "issue_editor");
const commentAuthor = alias(humans, "comment_author");
const knowledgeCreator = alias(humans, "knowledge_creator");
const knowledgeEditor = alias(humans, "knowledge_editor");
const activityActor = alias(humans, "activity_actor");
const accessGrantor = alias(humans, "access_grantor");

const projectColumns = {
  id: projects.id,
  workspaceId: projects.workspaceId,
  name: projects.name,
  createdAt: projects.createdAt,
  createdByHumanId: projects.createdByHumanId,
  createdByEmail: projectCreator.email,
};

const issueColumns = {
  id: issues.id,
  projectId: issues.projectId,
  number: issues.number,
  title: issues.title,
  body: issues.body,
  status: issues.status,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
  closedAt: issues.closedAt,
  createdByHumanId: issues.createdByHumanId,
  createdByEmail: issueCreator.email,
  updatedByHumanId: issues.updatedByHumanId,
  updatedByEmail: issueEditor.email,
};

const commentColumns = {
  id: issueComments.id,
  issueId: issueComments.issueId,
  body: issueComments.body,
  createdAt: issueComments.createdAt,
  authorHumanId: issueComments.createdByHumanId,
  authorEmail: commentAuthor.email,
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
  updatedByHumanId: knowledgeEntries.updatedByHumanId,
  updatedByEmail: knowledgeEditor.email,
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
};

type ProjectRow = {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: Date;
  createdByHumanId: string;
  createdByEmail: string;
  workspaceKind: WorkspaceKind;
  accessLevel: ProjectAccessLevel;
};

type ProjectGrantRow = {
  humanId: string;
  email: string;
  level: ProjectAccessLevel;
  grantedByHumanId: string;
  grantedByEmail: string;
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
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  createdByHumanId: string;
  createdByEmail: string;
  updatedByHumanId: string;
  updatedByEmail: string;
};

type CommentRow = {
  id: string;
  issueId: string;
  body: string;
  createdAt: Date;
  authorHumanId: string;
  authorEmail: string;
};

type KnowledgeRow = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  createdByHumanId: string;
  createdByEmail: string;
  updatedByHumanId: string;
  updatedByEmail: string;
};

type ActivityRow = {
  id: string;
  projectId: string;
  type: ProjectActivityType;
  summary: string;
  issueId: string | null;
  knowledgeEntryId: string | null;
  createdAt: Date;
  actorHumanId: string;
  actorEmail: string;
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    createdBy: { humanId: row.createdByHumanId, email: row.createdByEmail },
    workspaceKind: row.workspaceKind,
    accessLevel: row.accessLevel,
  };
}

function toProjectGrant(row: ProjectGrantRow): ProjectAccessGrant {
  return {
    humanId: row.humanId,
    email: row.email,
    level: row.level,
    grantedBy: { humanId: row.grantedByHumanId, email: row.grantedByEmail },
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    createdBy: { humanId: row.createdByHumanId, email: row.createdByEmail },
    updatedBy: { humanId: row.updatedByHumanId, email: row.updatedByEmail },
  };
}

function toComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issueId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    author: { humanId: row.authorHumanId, email: row.authorEmail },
  };
}

function toKnowledge(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: { humanId: row.createdByHumanId, email: row.createdByEmail },
    updatedBy: { humanId: row.updatedByHumanId, email: row.updatedByEmail },
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
    actor: { humanId: row.actorHumanId, email: row.actorEmail },
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
  humanId: string,
  required: ProjectAccessLevel,
) {
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
      and(
        eq(workspaceMemberships.workspaceId, projects.workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .leftJoin(
      projectAccessGrants,
      and(eq(projectAccessGrants.projectId, projects.id), eq(projectAccessGrants.humanId, humanId)),
    )
    .where(eq(projects.id, projectId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("project_not_found");
  return {
    ...row,
    workspaceKind: WorkspaceKind.parse(row.workspaceKind),
    grantLevel: row.grantLevel === null ? null : ProjectAccessLevel.parse(row.grantLevel),
    accessLevel: requireLevel(row, humanId, required, "project_not_found"),
  };
}

async function requireIssue(
  tx: DbTransaction,
  issueId: string,
  humanId: string,
  required: ProjectAccessLevel,
) {
  const [row] = await tx
    .select({
      ...issueColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
    .innerJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, projects.workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .leftJoin(
      projectAccessGrants,
      and(eq(projectAccessGrants.projectId, projects.id), eq(projectAccessGrants.humanId, humanId)),
    )
    .where(eq(issues.id, issueId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("issue_not_found");
  return { ...row, accessLevel: requireLevel(row, humanId, required, "issue_not_found") };
}

async function requireKnowledge(
  tx: DbTransaction,
  entryId: string,
  humanId: string,
  required: ProjectAccessLevel,
) {
  const [row] = await tx
    .select({
      ...knowledgeColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
    })
    .from(knowledgeEntries)
    .innerJoin(projects, eq(projects.id, knowledgeEntries.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
    .innerJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, projects.workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .leftJoin(
      projectAccessGrants,
      and(eq(projectAccessGrants.projectId, projects.id), eq(projectAccessGrants.humanId, humanId)),
    )
    .where(eq(knowledgeEntries.id, entryId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("knowledge_entry_not_found");
  return { ...row, accessLevel: requireLevel(row, humanId, required, "knowledge_entry_not_found") };
}

type RecordActivityInput =
  | {
      projectId: string;
      type: "project_created" | "project_renamed";
      actorHumanId: string;
      summary: string;
    }
  | {
      projectId: string;
      type:
        | "issue_created"
        | "issue_edited"
        | "issue_commented"
        | "issue_closed"
        | "issue_reopened";
      actorHumanId: string;
      summary: string;
      issueId: string;
    }
  | {
      projectId: string;
      type: "knowledge_created" | "knowledge_edited";
      actorHumanId: string;
      summary: string;
      knowledgeEntryId: string;
    };

// One activity event, written inside the caller's transaction so the change and its
// history commit together or not at all. The summary is the item's title at this moment.
async function recordActivity(tx: DbTransaction, input: RecordActivityInput) {
  await tx.insert(projectActivity).values({
    id: randomUUID(),
    projectId: input.projectId,
    type: input.type,
    actorHumanId: input.actorHumanId,
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

export interface ProjectsDeps {
  db: PostgresJsDatabase;
}

export interface ProjectsService {
  listProjects(account: SessionAccount | null, workspaceId: string): Promise<Project[]>;
  getProject(account: SessionAccount | null, projectId: string): Promise<Project>;
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
  listIssues(account: SessionAccount | null, projectId: string): Promise<Issue[]>;
  getIssue(account: SessionAccount | null, issueId: string): Promise<Issue>;
  createIssue(
    account: SessionAccount | null,
    projectId: string,
    input: CreateIssueRequest,
  ): Promise<Issue>;
  updateIssue(
    account: SessionAccount | null,
    issueId: string,
    input: UpdateIssueRequest,
  ): Promise<Issue>;
  listComments(account: SessionAccount | null, issueId: string): Promise<IssueComment[]>;
  createComment(
    account: SessionAccount | null,
    issueId: string,
    input: CreateIssueCommentRequest,
  ): Promise<IssueComment>;
  listActivity(account: SessionAccount | null, projectId: string): Promise<ProjectActivity[]>;
  listKnowledge(account: SessionAccount | null, projectId: string): Promise<KnowledgeEntry[]>;
  getKnowledge(account: SessionAccount | null, entryId: string): Promise<KnowledgeEntry>;
  createKnowledge(
    account: SessionAccount | null,
    projectId: string,
    input: CreateKnowledgeEntryRequest,
  ): Promise<KnowledgeEntry>;
  updateKnowledge(
    account: SessionAccount | null,
    entryId: string,
    input: UpdateKnowledgeEntryRequest,
  ): Promise<KnowledgeEntry>;
}

export function createProjectsService({ db }: ProjectsDeps): ProjectsService {
  return {
    // The listing is the caller's accessible projects in the workspace: all of a personal
    // workspace's own projects, all of a shared workspace's projects for an owner, and
    // only explicitly granted projects for an ordinary member. Membership validates the
    // workspace; it does not reveal the projects themselves.
    async listProjects(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          const workspace = await readWorkspaceFacts(tx, workspaceId, actor.humanId);
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
                eq(workspaceMemberships.humanId, actor.humanId),
              ),
            )
            .leftJoin(
              projectAccessGrants,
              and(
                eq(projectAccessGrants.projectId, projects.id),
                eq(projectAccessGrants.humanId, actor.humanId),
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
            const accessLevel = resolveAccessLevel(row, actor.humanId);
            return accessLevel === null ? [] : [toProject({ ...row, accessLevel })];
          });
        },
        { accessMode: "read only" },
      );
    },

    async getProject(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) =>
          toProject(
            await requireProject(tx, projectId, actor.humanId, ProjectAccessLevel.enum.read),
          ),
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
          actorHumanId: actor.humanId,
          summary: input.name,
        });
        return {
          id: created.id,
          workspaceId: created.workspaceId,
          name: created.name,
          createdAt: created.createdAt.toISOString(),
          createdBy: { humanId: actor.humanId, email: actor.email },
          workspaceKind: workspace.kind,
          accessLevel: ProjectAccessLevel.enum.manage,
        };
      });
    },

    // Manage may rename the project. A no-op keeps the project and its activity
    // unchanged, so a repeated save cannot invent history.
    async updateProject(account, projectId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        // Lock first, then authorize: a concurrent grant change cannot slip between the
        // access check and the rename.
        await lockProjectForMutation(tx, projectId);
        const current = await requireProject(
          tx,
          projectId,
          actor.humanId,
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
          actorHumanId: actor.humanId,
          summary: updated.name,
        });
        return toProject({ ...current, name: updated.name });
      });
    },

    // The explicit grants a project manager sees. Workspace owners are not listed because
    // their Manage is implicit (including members later promoted to owner); a personal
    // project has no collaborators at all.
    async listProjectAccess(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          const project = await requireProject(
            tx,
            projectId,
            actor.humanId,
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
      return db.transaction(async (tx) => {
        // Lock workspace membership writes before the project row so granting access
        // cannot race with removeMember() (orphaning a grant) or appointOwner().
        await lockWorkspaceOwnershipWrites(tx);
        await lockProjectForMutation(tx, projectId);
        const project = await requireProject(
          tx,
          projectId,
          actor.humanId,
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
      await db.transaction(async (tx) => {
        // Lock workspace membership writes before the project row so revoking access
        // cannot race with removeMember() and emit duplicate revocation events.
        await lockWorkspaceOwnershipWrites(tx);
        await lockProjectForMutation(tx, projectId);
        const project = await requireProject(
          tx,
          projectId,
          actor.humanId,
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

    async listIssues(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor.humanId, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(issueColumns)
            .from(issues)
            .innerJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
            .innerJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
            .where(eq(issues.projectId, projectId))
            .orderBy(issues.number);
          return rows.map(toIssue);
        },
        { accessMode: "read only" },
      );
    },

    async getIssue(account, issueId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) =>
          toIssue(await requireIssue(tx, issueId, actor.humanId, ProjectAccessLevel.enum.read)),
        { accessMode: "read only" },
      );
    },

    // The project row is updated before the issue is inserted: the row lock serializes
    // concurrent creations, and the returned value is the number this issue takes.
    async createIssue(account, projectId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireProject(tx, projectId, actor.humanId, ProjectAccessLevel.enum.contribute);
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
            createdByHumanId: actor.humanId,
            updatedByHumanId: actor.humanId,
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
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
            closedAt: issues.closedAt,
          });
        if (created === undefined) throw new Error("the issue was not created");
        await recordActivity(tx, {
          projectId,
          type: "issue_created",
          actorHumanId: actor.humanId,
          issueId: id,
          summary: input.title,
        });
        const author = { humanId: actor.humanId, email: actor.email };
        return {
          id: created.id,
          projectId: created.projectId,
          number: created.number,
          title: created.title,
          body: created.body,
          status: IssueStatus.parse(created.status),
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          closedAt: created.closedAt === null ? null : created.closedAt.toISOString(),
          createdBy: author,
          updatedBy: author,
        };
      });
    },

    // A title or body edit, a close, and a reopen are all this one transition. Only real
    // changes update the issue and write activity; a no-op answers with the issue as it
    // was, so a repeated close cannot invent a second event.
    async updateIssue(account, issueId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        // Serialize concurrent updates to the same issue so two PATCHes cannot lose
        // each other's changes or diverge the activity feed from the issue's status.
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
        const current = await requireIssue(
          tx,
          issueId,
          actor.humanId,
          ProjectAccessLevel.enum.contribute,
        );
        const title = input.title ?? current.title;
        const body = input.body ?? current.body;
        const status = input.status ?? current.status;
        const titleChanged = title !== current.title;
        const bodyChanged = body !== current.body;
        const statusChanged = status !== current.status;
        if (!titleChanged && !bodyChanged && !statusChanged) return toIssue(current);

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
            updatedByHumanId: actor.humanId,
            updatedAt: sql`statement_timestamp()`,
            closedAt,
          })
          .where(eq(issues.id, issueId))
          .returning({
            updatedAt: issues.updatedAt,
            closedAt: issues.closedAt,
          });
        if (updated === undefined) throw new ProjectsError("issue_not_found");

        if (titleChanged || bodyChanged) {
          await recordActivity(tx, {
            projectId: current.projectId,
            type: "issue_edited",
            actorHumanId: actor.humanId,
            issueId,
            summary: title,
          });
        }
        if (statusChanged) {
          await recordActivity(tx, {
            projectId: current.projectId,
            type: status === IssueStatus.enum.closed ? "issue_closed" : "issue_reopened",
            actorHumanId: actor.humanId,
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
          createdAt: current.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          closedAt: updated.closedAt === null ? null : updated.closedAt.toISOString(),
          createdBy: { humanId: current.createdByHumanId, email: current.createdByEmail },
          updatedBy: { humanId: actor.humanId, email: actor.email },
        };
      });
    },

    async listComments(account, issueId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireIssue(tx, issueId, actor.humanId, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(commentColumns)
            .from(issueComments)
            .innerJoin(commentAuthor, eq(commentAuthor.id, issueComments.createdByHumanId))
            .where(eq(issueComments.issueId, issueId))
            .orderBy(issueComments.createdAt, issueComments.id);
          return rows.map(toComment);
        },
        { accessMode: "read only" },
      );
    },

    // Comments need no work session (#20); they still need project access, which
    // requireIssue enforces, and they keep their author.
    async createComment(account, issueId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        const issue = await requireIssue(
          tx,
          issueId,
          actor.humanId,
          ProjectAccessLevel.enum.contribute,
        );
        const id = randomUUID();
        const [created] = await tx
          .insert(issueComments)
          .values({
            id,
            issueId,
            body: input.body,
            createdByHumanId: actor.humanId,
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
          actorHumanId: actor.humanId,
          issueId,
          summary: issue.title,
        });
        return {
          id: created.id,
          issueId: created.issueId,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          author: { humanId: actor.humanId, email: actor.email },
        };
      });
    },

    async listActivity(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor.humanId, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(activityColumns)
            .from(projectActivity)
            .innerJoin(activityActor, eq(activityActor.id, projectActivity.actorHumanId))
            .where(eq(projectActivity.projectId, projectId))
            .orderBy(projectActivity.createdAt, projectActivity.id);
          return rows.map(toActivity);
        },
        { accessMode: "read only" },
      );
    },

    async listKnowledge(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor.humanId, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(knowledgeColumns)
            .from(knowledgeEntries)
            .innerJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
            .innerJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
            .where(eq(knowledgeEntries.projectId, projectId))
            .orderBy(knowledgeEntries.createdAt, knowledgeEntries.id);
          return rows.map(toKnowledge);
        },
        { accessMode: "read only" },
      );
    },

    async getKnowledge(account, entryId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) =>
          toKnowledge(
            await requireKnowledge(tx, entryId, actor.humanId, ProjectAccessLevel.enum.read),
          ),
        { accessMode: "read only" },
      );
    },

    async createKnowledge(account, projectId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireProject(tx, projectId, actor.humanId, ProjectAccessLevel.enum.contribute);
        const id = randomUUID();
        const [created] = await tx
          .insert(knowledgeEntries)
          .values({
            id,
            projectId,
            title: input.title,
            body: input.body ?? "",
            createdByHumanId: actor.humanId,
            updatedByHumanId: actor.humanId,
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
          actorHumanId: actor.humanId,
          knowledgeEntryId: id,
          summary: input.title,
        });
        const author = { humanId: actor.humanId, email: actor.email };
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

    async updateKnowledge(account, entryId, input) {
      const actor = requireAccount(account);
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
          actor.humanId,
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
            updatedByHumanId: actor.humanId,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(knowledgeEntries.id, entryId))
          .returning({ updatedAt: knowledgeEntries.updatedAt });
        if (updated === undefined) throw new ProjectsError("knowledge_entry_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "knowledge_edited",
          actorHumanId: actor.humanId,
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
          createdBy: { humanId: current.createdByHumanId, email: current.createdByEmail },
          updatedBy: { humanId: actor.humanId, email: actor.email },
        };
      });
    },
  };
}
