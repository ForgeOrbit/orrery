import {
  InvitationStatus,
  ProjectAccessLevel,
  WorkspaceKind,
  type Actor,
  type HistoryEvent,
} from "@orrery/contract";
import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  agentKeyEvents,
  agents,
  humans,
  instanceSetup,
  invitations,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projects,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { projectAccessAtLeast } from "../projects/index.ts";

// The projects feature's access ceiling, borrowed through its public interface. The same
// resolver decides a project's own reads and its history visibility.
type ProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

// The service is the only file in this feature that decides anything. rest.ts stays thin:
// it resolves the session, calls one of these three methods, and maps the result.
//
// Scope policy (issue #32, user stories 82-85):
// - A workspace's owner sees membership, permission, credential, and project access
//   events in that workspace. A delegated permission manager sees membership/permission
//   events in the workspace and project access events only for projects they Manage;
//   credential history stays with the owner. A non-member answers 404, so a history
//   route cannot enumerate workspaces.
// - A human with any granted level on a project sees its attributed activity. Project
//   access history needs Manage (which a workspace owner holds implicitly). A project
//   outside the caller's access answers 404, exactly like the project itself.
// - A system administrator sees installation-level access events only. The administrator
//   role alone grants no workspace or project history, and the installation events carry
//   no workspace or project content.
// No event table stores a secret, and none of these projections selects a hash, token, or
// password, so a history read cannot return one.

export type HistoryErrorKind =
  | "not_signed_in"
  | "workspace_not_found"
  | "project_not_found"
  | "workspace_history_forbidden"
  | "not_system_administrator";

const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  project_not_found: "This project does not exist.",
  workspace_history_forbidden:
    "Only a workspace owner or permission manager can view this history.",
  not_system_administrator: "Only a system administrator can view installation history.",
} as const satisfies Record<HistoryErrorKind, string>;

export class HistoryError extends Error {
  readonly kind: HistoryErrorKind;

  constructor(kind: HistoryErrorKind) {
    super(messages[kind]);
    this.name = "HistoryError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new HistoryError("not_signed_in");
  return account;
}

// The actors are stable identities. A human's email is the label readers already see in
// project activity; an agent is named itself, never by its owner. The fallbacks keep a
// historical row readable if a label is missing without inventing a name.
function humanActor(id: string | null, email: string | null): Actor {
  return { humanId: id, email, displayName: email ?? id ?? "unknown human" };
}

function agentActor(id: string | null, name: string | null): Actor {
  return { agentId: id, agentName: name, displayName: name ?? id ?? "unknown agent" };
}

type Db = PostgresJsDatabase | DbTransaction;

type Scope = HistoryEvent["scope"];

function installationScope(): Scope {
  return { kind: "installation", id: "installation", name: null };
}

function sortNewestFirst(events: HistoryEvent[]): HistoryEvent[] {
  return events.toSorted((a, b) =>
    a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
  );
}

// An installation invitation's lifecycle is already persisted as status plus timestamps.
// Each recorded transition becomes one history event; the bootstrap row becomes another.
// These codes are view-level names for stored facts, not a new source of truth.
const INSTALLATION_TYPE = {
  bootstrap: "installation_bootstrap",
  invited: "installation_invitation_created",
  accepted: "installation_invitation_accepted",
  declined: "installation_invitation_declined",
  expired: "installation_invitation_expired",
  revoked: "installation_invitation_revoked",
} as const;

async function loadWorkspaceEvents(db: Db, workspaceId: string, workspaceName: string) {
  const actorHuman = alias(humans, "history_workspace_actor");
  const subjectHuman = alias(humans, "history_workspace_subject");
  const rows = await db
    .select({
      id: workspaceEvents.id,
      type: workspaceEvents.type,
      createdAt: workspaceEvents.createdAt,
      actorId: actorHuman.id,
      actorEmail: actorHuman.email,
      subjectId: subjectHuman.id,
      subjectEmail: subjectHuman.email,
    })
    .from(workspaceEvents)
    .leftJoin(actorHuman, eq(actorHuman.id, workspaceEvents.actorHumanId))
    .leftJoin(subjectHuman, eq(subjectHuman.id, workspaceEvents.subjectHumanId))
    .where(eq(workspaceEvents.workspaceId, workspaceId))
    .orderBy(desc(workspaceEvents.createdAt), desc(workspaceEvents.id));
  const scope: Scope = { kind: "workspace", id: workspaceId, name: workspaceName };
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "workspace_access",
    type: row.type,
    scope,
    createdAt: row.createdAt.toISOString(),
    actor: humanActor(row.actorId, row.actorEmail),
    subject: humanActor(row.subjectId, row.subjectEmail),
    summary: null,
    level: null,
    previousLevel: null,
  }));
}

async function loadKeyEvents(db: Db, workspaceId: string, workspaceName: string) {
  const actorHuman = alias(humans, "history_key_actor");
  const rows = await db
    .select({
      id: agentKeyEvents.id,
      type: agentKeyEvents.type,
      createdAt: agentKeyEvents.createdAt,
      actorId: actorHuman.id,
      actorEmail: actorHuman.email,
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(agentKeyEvents)
    .innerJoin(agents, eq(agents.id, agentKeyEvents.agentId))
    .leftJoin(actorHuman, eq(actorHuman.id, agentKeyEvents.actorHumanId))
    .where(eq(agentKeyEvents.workspaceId, workspaceId))
    .orderBy(desc(agentKeyEvents.createdAt), desc(agentKeyEvents.id));
  // No key, hash, or secret is selected: an audit read never exposes a credential.
  const scope: Scope = { kind: "workspace", id: workspaceId, name: workspaceName };
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "agent_key",
    type: row.type,
    scope,
    createdAt: row.createdAt.toISOString(),
    actor: humanActor(row.actorId, row.actorEmail),
    subject: agentActor(row.agentId, row.agentName),
    summary: null,
    level: null,
    previousLevel: null,
  }));
}

async function loadProjectAccessEvents(
  db: Db,
  // #46: only the events this workspace owned are readable here. A project transferred
  // in from another workspace keeps that workspace's grant/revoke history strictly there,
  // and a project that left still leaves its old events in the source's workspace history.
  workspaceId: string,
  // Project history narrows to one project; workspace history passes no ids so it reads
  // every event the workspace ever owned, including projects that have since moved out.
  projectIds?: readonly string[],
): Promise<HistoryEvent[]> {
  if (projectIds !== undefined && projectIds.length === 0) return [];
  const actorHuman = alias(humans, "history_access_actor");
  const subjectHuman = alias(humans, "history_access_subject");
  const conditions = [eq(projectAccessEvents.workspaceId, workspaceId)];
  if (projectIds !== undefined) {
    conditions.push(inArray(projectAccessEvents.projectId, [...projectIds]));
  }
  const rows = await db
    .select({
      id: projectAccessEvents.id,
      projectId: projectAccessEvents.projectId,
      type: projectAccessEvents.type,
      level: projectAccessEvents.level,
      previousLevel: projectAccessEvents.previousLevel,
      createdAt: projectAccessEvents.createdAt,
      actorId: actorHuman.id,
      actorEmail: actorHuman.email,
      subjectId: subjectHuman.id,
      subjectEmail: subjectHuman.email,
    })
    .from(projectAccessEvents)
    .leftJoin(actorHuman, eq(actorHuman.id, projectAccessEvents.actorHumanId))
    .leftJoin(subjectHuman, eq(subjectHuman.id, projectAccessEvents.subjectHumanId))
    .where(and(...conditions))
    .orderBy(desc(projectAccessEvents.createdAt), desc(projectAccessEvents.id));
  if (rows.length === 0) return [];
  const projectIdList = [...new Set(rows.map((row) => row.projectId))];
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIdList));
  const names = new Map(projectRows.map((project) => [project.id, project.name]));
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "project_access",
    type: row.type,
    // The project is the narrowest scope the reader was authorized for.
    scope: {
      kind: "project",
      id: row.projectId,
      name: names.get(row.projectId) ?? null,
    },
    createdAt: row.createdAt.toISOString(),
    actor: humanActor(row.actorId, row.actorEmail),
    subject: humanActor(row.subjectId, row.subjectEmail),
    summary: null,
    level: row.level === null ? null : ProjectAccessLevel.parse(row.level),
    previousLevel: row.previousLevel === null ? null : ProjectAccessLevel.parse(row.previousLevel),
  }));
}

async function loadProjectActivity(db: Db, projectId: string, projectName: string) {
  const actorHuman = alias(humans, "history_activity_human");
  const actorAgent = alias(agents, "history_activity_agent");
  const rows = await db
    .select({
      id: projectActivity.id,
      type: projectActivity.type,
      summary: projectActivity.summary,
      createdAt: projectActivity.createdAt,
      humanId: actorHuman.id,
      humanEmail: actorHuman.email,
      agentId: actorAgent.id,
      agentName: actorAgent.name,
    })
    .from(projectActivity)
    .leftJoin(actorHuman, eq(actorHuman.id, projectActivity.actorHumanId))
    .leftJoin(actorAgent, eq(actorAgent.id, projectActivity.actorAgentId))
    .where(eq(projectActivity.projectId, projectId))
    .orderBy(desc(projectActivity.createdAt), desc(projectActivity.id));
  const scope: Scope = { kind: "project", id: projectId, name: projectName };
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "project_activity",
    type: row.type,
    scope,
    createdAt: row.createdAt.toISOString(),
    actor:
      row.agentId !== null
        ? agentActor(row.agentId, row.agentName)
        : humanActor(row.humanId, row.humanEmail),
    subject: null,
    summary: row.summary,
    level: null,
    previousLevel: null,
  }));
}

async function loadInstallationEvents(db: Db): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  const scope = installationScope();

  const [setup] = await db
    .select({
      humanId: instanceSetup.administratorHumanId,
      email: humans.email,
      createdAt: instanceSetup.completedAt,
    })
    .from(instanceSetup)
    .innerJoin(humans, eq(humans.id, instanceSetup.administratorHumanId))
    .limit(1);
  if (setup !== undefined) {
    events.push({
      id: `installation_setup:${setup.humanId}`,
      kind: "installation_access",
      type: INSTALLATION_TYPE.bootstrap,
      scope,
      createdAt: setup.createdAt.toISOString(),
      actor: humanActor(setup.humanId, setup.email),
      subject: humanActor(setup.humanId, setup.email),
      summary: `Installation bootstrapped by ${setup.email}`,
      level: null,
      previousLevel: null,
    });
  }

  const inviter = alias(humans, "history_invitation_inviter");
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      status: invitations.status,
      createdAt: invitations.createdAt,
      acceptedAt: invitations.acceptedAt,
      declinedAt: invitations.declinedAt,
      expiredAt: invitations.expiredAt,
      revokedAt: invitations.revokedAt,
      inviterId: inviter.id,
      inviterEmail: inviter.email,
    })
    .from(invitations)
    .leftJoin(inviter, eq(inviter.id, invitations.invitedByHumanId))
    .orderBy(desc(invitations.createdAt), desc(invitations.id));
  for (const row of rows) {
    const inviterActor = humanActor(row.inviterId, row.inviterEmail);
    const inviteeActor = humanActor(null, row.email);
    const add = (type: string, at: Date | null, actor: Actor, subject: Actor) => {
      if (at === null) return;
      events.push({
        id: `${row.id}:${type}`,
        kind: "installation_access",
        type,
        scope,
        createdAt: at.toISOString(),
        actor,
        subject,
        summary: `Installation invitation for ${row.email}`,
        level: null,
        previousLevel: null,
      });
    };
    add(INSTALLATION_TYPE.invited, row.createdAt, inviterActor, inviteeActor);
    // Accepting and declining are the recipient's acts: they are the actor and the
    // inviter is the subject. Issuing, expiry, and revocation stay the inviter's acts.
    if (row.status === InvitationStatus.enum.accepted)
      add(INSTALLATION_TYPE.accepted, row.acceptedAt, inviteeActor, inviterActor);
    if (row.status === InvitationStatus.enum.declined)
      add(INSTALLATION_TYPE.declined, row.declinedAt, inviteeActor, inviterActor);
    if (row.status === InvitationStatus.enum.expired)
      add(INSTALLATION_TYPE.expired, row.expiredAt, inviterActor, inviteeActor);
    if (row.status === InvitationStatus.enum.revoked)
      add(INSTALLATION_TYPE.revoked, row.revokedAt, inviterActor, inviteeActor);
  }
  return events;
}

export interface HistoryDeps {
  db: PostgresJsDatabase;
  // The same project-level resolver every human-facing project route uses, so a history
  // read can never grant itself more project authority than the project itself.
  projectAccessCeiling: ProjectAccessCeiling;
}

export interface HistoryService {
  workspaceHistory(account: SessionAccount | null, workspaceId: string): Promise<HistoryEvent[]>;
  projectHistory(account: SessionAccount | null, projectId: string): Promise<HistoryEvent[]>;
  installationHistory(account: SessionAccount | null): Promise<HistoryEvent[]>;
}

export function createHistoryService({ db, projectAccessCeiling }: HistoryDeps): HistoryService {
  return {
    async workspaceHistory(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({
              id: workspaces.id,
              kind: workspaces.kind,
              name: workspaces.name,
              personalOwnerId: workspaces.personalOwnerHumanId,
              isOwner: workspaceMemberships.isOwner,
              canManageMemberPermissions: workspaceMemberships.canManageMemberPermissions,
            })
            .from(workspaces)
            .leftJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, workspaces.id),
                eq(workspaceMemberships.humanId, actor.humanId),
              ),
            )
            .where(eq(workspaces.id, workspaceId))
            .limit(1);
          if (row === undefined) throw new HistoryError("workspace_not_found");

          const personal = row.kind === WorkspaceKind.enum.personal;
          const isOwner = personal ? row.personalOwnerId === actor.humanId : row.isOwner === true;
          // A personal workspace belongs to one human; a shared one to its members. Anyone
          // else gets the same 404 as a missing id, so history cannot enumerate workspaces.
          const inScope = personal ? row.personalOwnerId === actor.humanId : row.isOwner !== null;
          if (!inScope) throw new HistoryError("workspace_not_found");
          // Credential history is the owner's; a delegate's authority is permission
          // management plus the projects they Manage.
          if (!isOwner && row.canManageMemberPermissions !== true) {
            throw new HistoryError("workspace_history_forbidden");
          }

          const events: HistoryEvent[] = [
            ...(await loadWorkspaceEvents(tx, workspaceId, row.name)),
          ];
          if (isOwner) {
            events.push(...(await loadKeyEvents(tx, workspaceId, row.name)));
            // Every access change this workspace ever owned, including projects that
            // have since moved away (#46).
            events.push(...(await loadProjectAccessEvents(tx, workspaceId)));
          } else {
            const managed = await tx
              .select({ id: projects.id })
              .from(projects)
              .innerJoin(
                projectAccessGrants,
                and(
                  eq(projectAccessGrants.projectId, projects.id),
                  eq(projectAccessGrants.humanId, actor.humanId),
                  eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage),
                ),
              )
              .where(eq(projects.workspaceId, workspaceId));
            events.push(
              ...(await loadProjectAccessEvents(
                tx,
                workspaceId,
                managed.map((project) => project.id),
              )),
            );
          }
          return sortNewestFirst(events);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async projectHistory(account, projectId) {
      const actor = requireAccount(account);
      const [project] = await db
        .select({ id: projects.id, workspaceId: projects.workspaceId, name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (project === undefined) throw new HistoryError("project_not_found");

      const level = await db.transaction(
        async (tx) => {
          const ceiling = await projectAccessCeiling(tx, project.workspaceId, actor.humanId, [
            projectId,
          ]);
          return ceiling.get(projectId) ?? null;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
      // No current access is the same answer as no such project. Membership alone, a
      // stale grant after removal, and another workspace's project all look identical.
      if (level === null) throw new HistoryError("project_not_found");

      // Every granted level follows ordinary project activity. Only Manage (which an
      // owner holds implicitly) additionally sees who changed the project's access.
      const events = await loadProjectActivity(db, projectId, project.name);
      if (projectAccessAtLeast(level, ProjectAccessLevel.enum.manage)) {
        events.push(...(await loadProjectAccessEvents(db, project.workspaceId, [projectId])));
      }
      return sortNewestFirst(events);
    },

    async installationHistory(account) {
      const actor = requireAccount(account);
      if (!actor.isSystemAdministrator) throw new HistoryError("not_system_administrator");
      // Installation events are derived from the installation's own records only; a
      // workspace or project the administrator does not belong to never appears here.
      return sortNewestFirst(await loadInstallationEvents(db));
    },
  };
}
