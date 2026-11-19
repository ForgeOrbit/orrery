import { randomUUID } from "node:crypto";
import {
  IssueStatus,
  WorkspaceKind,
  type CreateIssueCommentRequest,
  type CreateIssueRequest,
  type CreateKnowledgeEntryRequest,
  type CreateProjectRequest,
  type Issue,
  type IssueComment,
  type KnowledgeEntry,
  type Project,
  type ProjectActivity,
  type ProjectActivityType,
  type UpdateIssueRequest,
  type UpdateKnowledgeEntryRequest,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  humans,
  issueComments,
  issues,
  knowledgeEntries,
  projectActivity,
  projects,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";

// The service is the only file in this feature that decides anything. rest.ts calls it.
//
// Projects are personal in this slice (#26): only the owner of a personal workspace can
// list, create, or access its projects. Shared workspaces gain project creation and the
// Read/Contribute/Manage levels with #27, so they have no project surface yet. Every
// project query applies the one access predicate below, so no transport can bypass it.

export type ProjectsErrorKind =
  | "not_signed_in"
  | "workspace_not_found"
  | "project_not_found"
  | "issue_not_found"
  | "knowledge_entry_not_found";

const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  project_not_found: "This project does not exist.",
  issue_not_found: "This issue does not exist.",
  knowledge_entry_not_found: "This knowledge entry does not exist.",
} as const satisfies Record<ProjectsErrorKind, string>;

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

// The one project access predicate for #26: the workspace is personal, and the caller is
// its owner. Shared workspaces gain project access with #27; until then they have no
// project surface. Every workspace and project query below applies this same predicate.
function canAccessProject(
  row: { workspaceKind: WorkspaceKind; personalOwnerHumanId: string | null },
  humanId: string,
): boolean {
  return row.workspaceKind === WorkspaceKind.enum.personal && row.personalOwnerHumanId === humanId;
}

// A workspace outside the caller's personal ownership answers exactly like a missing one.
async function requireWorkspace(tx: DbTransaction, workspaceId: string, humanId: string) {
  const [row] = await tx
    .select({
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (row === undefined || !canAccessProject(row, humanId)) {
    throw new ProjectsError("workspace_not_found");
  }
  return row;
}

// The project and the caller's access to it, in one query. A caller who cannot access the
// project gets the same answer as one asking for a missing project, so project ids cannot
// be enumerated.
async function requireProject(tx: DbTransaction, projectId: string, humanId: string) {
  const [row] = await tx
    .select({
      ...projectColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
    })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(projectCreator, eq(projectCreator.id, projects.createdByHumanId))
    .where(eq(projects.id, projectId))
    .limit(1);

  if (row === undefined || !canAccessProject(row, humanId)) {
    throw new ProjectsError("project_not_found");
  }
  return row;
}

async function requireIssue(tx: DbTransaction, issueId: string, humanId: string) {
  const [row] = await tx
    .select({
      ...issueColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
    .innerJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
    .where(eq(issues.id, issueId))
    .limit(1);

  if (row === undefined || !canAccessProject(row, humanId)) {
    throw new ProjectsError("issue_not_found");
  }
  return row;
}

async function requireKnowledge(tx: DbTransaction, entryId: string, humanId: string) {
  const [row] = await tx
    .select({
      ...knowledgeColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
    })
    .from(knowledgeEntries)
    .innerJoin(projects, eq(projects.id, knowledgeEntries.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
    .innerJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
    .where(eq(knowledgeEntries.id, entryId))
    .limit(1);

  if (row === undefined || !canAccessProject(row, humanId)) {
    throw new ProjectsError("knowledge_entry_not_found");
  }
  return row;
}

async function issueById(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select(issueColumns)
    .from(issues)
    .innerJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
    .innerJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row === undefined) throw new ProjectsError("issue_not_found");
  return toIssue(row);
}

async function commentById(tx: DbTransaction, commentId: string) {
  const [row] = await tx
    .select(commentColumns)
    .from(issueComments)
    .innerJoin(commentAuthor, eq(commentAuthor.id, issueComments.createdByHumanId))
    .where(eq(issueComments.id, commentId))
    .limit(1);
  if (row === undefined) throw new Error("the comment was not created");
  return toComment(row);
}

async function knowledgeById(tx: DbTransaction, entryId: string) {
  const [row] = await tx
    .select(knowledgeColumns)
    .from(knowledgeEntries)
    .innerJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
    .innerJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
    .where(eq(knowledgeEntries.id, entryId))
    .limit(1);
  if (row === undefined) throw new ProjectsError("knowledge_entry_not_found");
  return toKnowledge(row);
}

// One activity event, written inside the caller's transaction so the change and its
// history commit together or not at all. The summary is the item's title at this moment.
async function recordActivity(
  tx: DbTransaction,
  input: {
    projectId: string;
    type: ProjectActivityType;
    actorHumanId: string;
    summary: string;
    issueId?: string;
    knowledgeEntryId?: string;
  },
) {
  await tx.insert(projectActivity).values({
    id: randomUUID(),
    projectId: input.projectId,
    type: input.type,
    actorHumanId: input.actorHumanId,
    summary: input.summary,
    createdAt: sql`statement_timestamp()`,
    ...(input.issueId === undefined ? {} : { issueId: input.issueId }),
    ...(input.knowledgeEntryId === undefined ? {} : { knowledgeEntryId: input.knowledgeEntryId }),
  });
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
    // The listing starts from the caller's personal workspace. A shared workspace has no
    // project surface in #26, and a workspace outside the caller's ownership answers like
    // a missing one.
    async listProjects(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireWorkspace(tx, workspaceId, actor.humanId);
          const rows = await tx
            .select(projectColumns)
            .from(projects)
            .innerJoin(projectCreator, eq(projectCreator.id, projects.createdByHumanId))
            .where(eq(projects.workspaceId, workspaceId))
            .orderBy(projects.createdAt, projects.id);
          return rows.map(toProject);
        },
        { accessMode: "read only" },
      );
    },

    async getProject(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => toProject(await requireProject(tx, projectId, actor.humanId)),
        { accessMode: "read only" },
      );
    },

    // The creator is recorded, and the workspace keeps the project: the creator does not
    // become a second owner. Only the personal workspace's owner can create one in #26;
    // shared-workspace creation arrives with #27.
    async createProject(account, workspaceId, input) {
      const actor = requireAccount(account);
      const id = randomUUID();
      return db.transaction(async (tx) => {
        await requireWorkspace(tx, workspaceId, actor.humanId);
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
        };
      });
    },

    async listIssues(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor.humanId);
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
      return db.transaction(async (tx) => toIssue(await requireIssue(tx, issueId, actor.humanId)), {
        accessMode: "read only",
      });
    },

    // The project row is updated before the issue is inserted: the row lock serializes
    // concurrent creations, and the returned value is the number this issue takes.
    async createIssue(account, projectId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireProject(tx, projectId, actor.humanId);
        const [counter] = await tx
          .update(projects)
          .set({ nextIssueNumber: sql`${projects.nextIssueNumber} + 1` })
          .where(eq(projects.id, projectId))
          .returning({ number: sql<number>`${projects.nextIssueNumber} - 1` });
        if (counter === undefined) throw new ProjectsError("project_not_found");

        const id = randomUUID();
        await tx.insert(issues).values({
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
        });
        await recordActivity(tx, {
          projectId,
          type: "issue_created",
          actorHumanId: actor.humanId,
          issueId: id,
          summary: input.title,
        });
        return issueById(tx, id);
      });
    },

    // A title or body edit, a close, and a reopen are all this one transition. Only real
    // changes update the issue and write activity; a no-op answers with the issue as it
    // was, so a repeated close cannot invent a second event.
    async updateIssue(account, issueId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        const current = await requireIssue(tx, issueId, actor.humanId);
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
        await tx
          .update(issues)
          .set({
            title,
            body,
            status,
            updatedByHumanId: actor.humanId,
            updatedAt: sql`statement_timestamp()`,
            closedAt,
          })
          .where(eq(issues.id, issueId));

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
        return issueById(tx, issueId);
      });
    },

    async listComments(account, issueId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireIssue(tx, issueId, actor.humanId);
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
        const issue = await requireIssue(tx, issueId, actor.humanId);
        const id = randomUUID();
        await tx.insert(issueComments).values({
          id,
          issueId,
          body: input.body,
          createdByHumanId: actor.humanId,
          createdAt: sql`statement_timestamp()`,
        });
        await recordActivity(tx, {
          projectId: issue.projectId,
          type: "issue_commented",
          actorHumanId: actor.humanId,
          issueId,
          summary: issue.title,
        });
        return commentById(tx, id);
      });
    },

    async listActivity(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor.humanId);
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
          await requireProject(tx, projectId, actor.humanId);
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
        async (tx) => toKnowledge(await requireKnowledge(tx, entryId, actor.humanId)),
        { accessMode: "read only" },
      );
    },

    async createKnowledge(account, projectId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireProject(tx, projectId, actor.humanId);
        const id = randomUUID();
        await tx.insert(knowledgeEntries).values({
          id,
          projectId,
          title: input.title,
          body: input.body ?? "",
          createdByHumanId: actor.humanId,
          updatedByHumanId: actor.humanId,
          createdAt: sql`statement_timestamp()`,
          updatedAt: sql`statement_timestamp()`,
        });
        await recordActivity(tx, {
          projectId,
          type: "knowledge_created",
          actorHumanId: actor.humanId,
          knowledgeEntryId: id,
          summary: input.title,
        });
        return knowledgeById(tx, id);
      });
    },

    async updateKnowledge(account, entryId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        const current = await requireKnowledge(tx, entryId, actor.humanId);
        const title = input.title ?? current.title;
        const body = input.body ?? current.body;
        if (title === current.title && body === current.body) return toKnowledge(current);
        await tx
          .update(knowledgeEntries)
          .set({
            title,
            body,
            updatedByHumanId: actor.humanId,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(knowledgeEntries.id, entryId));
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "knowledge_edited",
          actorHumanId: actor.humanId,
          knowledgeEntryId: entryId,
          summary: title,
        });
        return knowledgeById(tx, entryId);
      });
    },
  };
}
