import { randomBytes, randomUUID } from "node:crypto";
import {
  AgentKeyEventType,
  AgentKeyValidity,
  ProjectAccessLevel,
  type Agent,
  type AgentIdentity,
  type AgentKey,
  type AgentKeyProject,
  type CreateAgentKeyRequest,
  type CreateAgentKeyResponse,
  type CreateAgentRequest,
} from "@orrery/contract";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { uniqueConstraintName } from "../../platform/errors.ts";
import { tokenHash } from "../../platform/tokens.ts";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agentKeyEvents,
  agents,
  humans,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount, SessionReader } from "../accounts/index.ts";

// The service is the only file in this feature that decides anything. rest.ts validates
// and maps results; every rule about who may act, which workspace a key can reach, and
// how a human's current access caps an agent lives here.

const ACCESS_RANK: Record<ProjectAccessLevel, number> = { read: 1, contribute: 2, manage: 3 };

// The offered lifetimes in days. "never" has no row here: its key has a null expiry and
// skips only the time check, never the access checks.
const VALIDITY_DAYS: Record<Exclude<AgentKeyValidity, "never">, number> = {
  "7": 7,
  "14": 14,
  "30": 30,
  "60": 60,
  "90": 90,
};

// Keys are random bearer credentials with a recognizable prefix. Only their SHA-256 is
// stored (platform/tokens.ts); the raw secret is returned once, when the key is issued.
const newSecret = () => `orr_ak_${randomBytes(32).toString("base64url")}`;

export type AgentsErrorKind =
  | "not_signed_in"
  | "agent_name_taken"
  | "agent_not_found"
  | "workspace_not_found"
  | "not_workspace_owner"
  | "key_not_found"
  | "invalid_key_grant"
  | "invalid_key"
  | "key_revoked"
  | "key_expired"
  | "key_owner_inactive"
  | "key_out_of_scope"
  | "insufficient_agent_access";

const messages: Record<AgentsErrorKind, string> = {
  not_signed_in: "Not signed in.",
  agent_name_taken: "You already have an agent with this name.",
  agent_not_found: "No agent with this id belongs to you.",
  workspace_not_found: "This workspace does not exist or you cannot access it.",
  not_workspace_owner: "Only a workspace owner can do that.",
  key_not_found: "No such key in this scope.",
  invalid_key_grant: "A project is outside the workspace, or above your current access.",
  invalid_key: "The API key is not valid.",
  key_revoked: "The API key has been revoked.",
  key_expired: "The API key has expired.",
  key_owner_inactive: "The human who owns this key is inactive.",
  key_out_of_scope: "The API key is not scoped to this workspace.",
  insufficient_agent_access: "The agent has no access to this project.",
};

export class AgentsError extends Error {
  readonly kind: AgentsErrorKind;

  constructor(kind: AgentsErrorKind) {
    super(messages[kind]);
    this.name = "AgentsError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new AgentsError("not_signed_in");
  return account;
}

// A project ceiling decided by the projects feature's one resolver, borrowed through
// the feature's public interface. Agents never grow a second project-level policy.
export type ProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export interface AgentsDeps {
  db: PostgresJsDatabase;
  sessionReader: SessionReader;
  projectAccessCeiling: ProjectAccessCeiling;
}

export interface AgentKeyTarget {
  workspaceId?: string | undefined;
  projectId?: string | undefined;
}

export interface AgentsService {
  createAgent(account: SessionAccount | null, input: CreateAgentRequest): Promise<Agent>;
  listAgents(account: SessionAccount | null): Promise<Agent[]>;
  issueKey(
    account: SessionAccount | null,
    input: CreateAgentKeyRequest,
  ): Promise<CreateAgentKeyResponse>;
  listKeys(account: SessionAccount | null, workspaceId?: string): Promise<AgentKey[]>;
  revokeKey(account: SessionAccount | null, keyId: string): Promise<AgentKey>;
  // The owner's view and revocation of any key scoped to their workspace. The secret is
  // never fetched or returned on this path; the owner does not need it to revoke.
  workspaceKeys(account: SessionAccount | null, workspaceId: string): Promise<AgentKey[]>;
  ownerRevokeKey(
    account: SessionAccount | null,
    workspaceId: string,
    keyId: string,
  ): Promise<AgentKey>;
  // Bearer authentication: resolve the agent behind a key, capped by its human owner's
  // current access. An optional target makes a cross-workspace request fail on the server.
  authenticate(token: string, target?: AgentKeyTarget): Promise<AgentIdentity>;
}

// The human's current authority over a shared workspace; a personal workspace's owner
// is its personal_owner_human_id. Membership alone is enough to hold a key here —
// project levels are still capped separately by projectAccessCeiling.
async function humanCanUseWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipId: workspaceMemberships.id,
      humanActive: humans.isActive,
    })
    .from(workspaces)
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .innerJoin(humans, eq(humans.id, humanId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (row === undefined || !row.humanActive) return false;
  return row.personalOwnerHumanId === humanId || row.membershipId !== null;
}

async function requireWorkspaceOwner(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<void> {
  const [row] = await tx
    .select({
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      isOwner: workspaceMemberships.isOwner,
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
  const isOwner = row?.personalOwnerHumanId === humanId || row?.isOwner === true;
  if (!isOwner) throw new AgentsError("not_workspace_owner");
}

// Credential events identify the key without ever carrying its hash or secret. Written
// inside the same transaction as the change, so history cannot disagree with the row.
async function recordEvent(
  tx: DbTransaction,
  type: AgentKeyEventType,
  key: { id: string; agentId: string; workspaceId: string },
  actorHumanId: string,
): Promise<void> {
  await tx.insert(agentKeyEvents).values({
    id: randomUUID(),
    keyId: key.id,
    agentId: key.agentId,
    workspaceId: key.workspaceId,
    type,
    actorHumanId,
  });
}

type KeyRow = {
  id: string;
  agentId: string;
  workspaceId: string;
  createdByHumanId: string;
  validity: AgentKeyValidity;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByHumanId: string | null;
};

function keyRowColumns() {
  return {
    id: agentApiKeys.id,
    agentId: agentApiKeys.agentId,
    workspaceId: agentApiKeys.workspaceId,
    createdByHumanId: agentApiKeys.createdByHumanId,
    validity: agentApiKeys.validity,
    createdAt: agentApiKeys.createdAt,
    expiresAt: agentApiKeys.expiresAt,
    revokedAt: agentApiKeys.revokedAt,
    revokedByHumanId: agentApiKeys.revokedByHumanId,
  };
}

function toKey(row: KeyRow, projects: AgentKeyProject[]): AgentKey {
  return {
    id: row.id,
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    createdByHumanId: row.createdByHumanId,
    validity: AgentKeyValidity.parse(row.validity),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByHumanId: row.revokedByHumanId,
    projects,
  };
}

// Project grants for a set of keys, in one query, so listing many keys is not N+1.
async function loadKeyProjects(
  tx: DbTransaction,
  keyIds: readonly string[],
): Promise<Map<string, AgentKeyProject[]>> {
  const byKey = new Map<string, AgentKeyProject[]>();
  if (keyIds.length === 0) return byKey;
  const rows = await tx
    .select({
      keyId: agentApiKeyProjects.keyId,
      projectId: agentApiKeyProjects.projectId,
      level: agentApiKeyProjects.level,
    })
    .from(agentApiKeyProjects)
    .where(inArray(agentApiKeyProjects.keyId, [...keyIds]));
  for (const row of rows) {
    const list = byKey.get(row.keyId) ?? [];
    list.push({
      projectId: row.projectId,
      level: ProjectAccessLevel.parse(row.level),
    });
    byKey.set(row.keyId, list);
  }
  return byKey;
}

async function projectKey(tx: DbTransaction, keyId: string): Promise<AgentKey> {
  const [row] = await tx
    .select(keyRowColumns())
    .from(agentApiKeys)
    .where(eq(agentApiKeys.id, keyId))
    .limit(1);
  if (row === undefined) throw new AgentsError("key_not_found");
  const projects = await loadKeyProjects(tx, [keyId]);
  return toKey(
    { ...row, validity: AgentKeyValidity.parse(row.validity) },
    projects.get(keyId) ?? [],
  );
}

// Revoke in database time and write the event in one transaction. Both the human owner
// and a workspace owner go through this, so revocation has one implementation; only the
// authorization and the workspace scope differ.
async function revokeInTransaction(
  tx: DbTransaction,
  keyId: string,
  actorHumanId: string,
): Promise<AgentKey> {
  await tx
    .update(agentApiKeys)
    .set({ revokedAt: sql`now()`, revokedByHumanId: actorHumanId })
    .where(and(eq(agentApiKeys.id, keyId), isNull(agentApiKeys.revokedAt)));
  const key = await projectKey(tx, keyId);
  await recordEvent(
    tx,
    AgentKeyEventType.enum.agent_key_revoked,
    { id: key.id, agentId: key.agentId, workspaceId: key.workspaceId },
    actorHumanId,
  );
  return key;
}

// Bearer resolution inside one transaction: the lookup, the revocation/expiry/activity
// checks, the dynamic human-access ceiling, and the optional target scope all see one
// consistent snapshot.
async function resolveKeyInTransaction(
  tx: DbTransaction,
  projectAccessCeiling: ProjectAccessCeiling,
  token: string,
  target?: AgentKeyTarget,
): Promise<AgentIdentity> {
  const [row] = await tx
    .select({
      key: keyRowColumns(),
      agentName: agents.name,
      humanId: agents.humanId,
      humanActive: humans.isActive,
    })
    .from(agentApiKeys)
    .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
    .innerJoin(humans, eq(humans.id, agents.humanId))
    .where(eq(agentApiKeys.tokenHash, tokenHash(token)))
    .limit(1);
  if (row === undefined) throw new AgentsError("invalid_key");

  // Revocation wins over everything, including "Never": it is checked on every request
  // and takes effect immediately, independently of any connection state.
  if (row.key.revokedAt !== null) throw new AgentsError("key_revoked");
  if (!row.humanActive) throw new AgentsError("key_owner_inactive");

  // Expiry is evaluated in database time. "Never" has a null expiry and skips only this
  // check; it is still subject to revocation, active status, and every access check.
  if (AgentKeyValidity.parse(row.key.validity) !== AgentKeyValidity.enum.never) {
    const [live] = await tx
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.id, row.key.id), gt(agentApiKeys.expiresAt, sql`now()`)))
      .limit(1);
    if (live === undefined) throw new AgentsError("key_expired");
  }

  // A key is scoped to exactly one workspace. A request naming another workspace fails
  // here, before any project is considered.
  if (target?.workspaceId !== undefined && target.workspaceId !== row.key.workspaceId) {
    throw new AgentsError("key_out_of_scope");
  }

  // Dynamic ceiling: the key's requested level is the upper bound, and the human
  // owner's *current* project access is the lower one. If the human loses access, the
  // effective level drops with it on the very next request — no reissue is needed.
  const grants = await loadKeyProjects(tx, [row.key.id]);
  const requested = grants.get(row.key.id) ?? [];
  const ceiling = await projectAccessCeiling(
    tx,
    row.key.workspaceId,
    row.humanId,
    requested.map((grant) => grant.projectId),
  );
  const effective: AgentKeyProject[] = [];
  for (const grant of requested) {
    const humanLevel = ceiling.get(grant.projectId);
    if (humanLevel === undefined || humanLevel === null) continue;
    effective.push({
      projectId: grant.projectId,
      level: ACCESS_RANK[humanLevel] >= ACCESS_RANK[grant.level] ? grant.level : humanLevel,
    });
  }

  if (
    target?.projectId !== undefined &&
    !effective.some((grant) => grant.projectId === target.projectId)
  ) {
    throw new AgentsError("insufficient_agent_access");
  }

  return {
    agentId: row.key.agentId,
    name: row.agentName,
    humanId: row.humanId,
    keyId: row.key.id,
    workspaceId: row.key.workspaceId,
    validity: AgentKeyValidity.parse(row.key.validity),
    projects: effective,
  };
}

export function createAgentsService({ db, projectAccessCeiling }: AgentsDeps): AgentsService {
  return {
    async createAgent(account, input) {
      const actor = requireAccount(account);
      const id = randomUUID();
      const createdAt = new Date();
      try {
        await db.insert(agents).values({ id, humanId: actor.humanId, name: input.name, createdAt });
      } catch (error) {
        if (uniqueConstraintName(error) === "one_agent_name_per_human") {
          throw new AgentsError("agent_name_taken");
        }
        throw error;
      }
      const agent: Agent = {
        id,
        humanId: actor.humanId,
        name: input.name,
        createdAt: createdAt.toISOString(),
      };
      return agent;
    },

    async listAgents(account) {
      const actor = requireAccount(account);
      const rows = await db
        .select({
          id: agents.id,
          humanId: agents.humanId,
          name: agents.name,
          createdAt: agents.createdAt,
        })
        .from(agents)
        .where(eq(agents.humanId, actor.humanId));
      return rows.map((row) => ({
        id: row.id,
        humanId: row.humanId,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async issueKey(account, input) {
      const actor = requireAccount(account);
      const validity = AgentKeyValidity.parse(input.validity ?? AgentKeyValidity.enum["90"]);
      return db.transaction(async (tx) => {
        const [agent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.humanId, actor.humanId)))
          .limit(1);
        if (agent === undefined) throw new AgentsError("agent_not_found");

        if (!(await humanCanUseWorkspace(tx, input.workspaceId, actor.humanId))) {
          throw new AgentsError("workspace_not_found");
        }

        // Issuance needs a current project access, but the requested level is only a
        // ceiling: it may be higher than the human's level, and the effective access is
        // then capped down to what the human can actually do right now. This is what
        // makes the cap dynamic — lowering the human's access later lowers the agent
        // without reissuing the key.
        const requested = input.projects;
        const ceiling = await projectAccessCeiling(
          tx,
          input.workspaceId,
          actor.humanId,
          requested.map((grant) => grant.projectId),
        );
        for (const grant of requested) {
          const humanLevel = ceiling.get(grant.projectId);
          if (humanLevel === undefined || humanLevel === null) {
            throw new AgentsError("invalid_key_grant");
          }
        }

        const secret = newSecret();
        const id = randomUUID();
        const [row] = await tx
          .insert(agentApiKeys)
          .values({
            id,
            agentId: agent.id,
            workspaceId: input.workspaceId,
            createdByHumanId: actor.humanId,
            validity,
            tokenHash: tokenHash(secret),
            expiresAt:
              validity === AgentKeyValidity.enum.never
                ? null
                : sql`now() + make_interval(days => ${VALIDITY_DAYS[validity]})`,
          })
          .returning(keyRowColumns());
        if (row === undefined) throw new AgentsError("invalid_key_grant");

        if (requested.length > 0) {
          await tx.insert(agentApiKeyProjects).values(
            requested.map((grant) => ({
              id: randomUUID(),
              keyId: id,
              projectId: grant.projectId,
              level: grant.level,
            })),
          );
        }
        await recordEvent(
          tx,
          AgentKeyEventType.enum.agent_key_created,
          { id, agentId: agent.id, workspaceId: input.workspaceId },
          actor.humanId,
        );
        return { key: toKey(row, requested), secret };
      });
    },

    async listKeys(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select(keyRowColumns())
          .from(agentApiKeys)
          .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
          .where(
            workspaceId === undefined
              ? eq(agents.humanId, actor.humanId)
              : and(eq(agents.humanId, actor.humanId), eq(agentApiKeys.workspaceId, workspaceId)),
          );
        const projects = await loadKeyProjects(
          tx,
          rows.map((row) => row.id),
        );
        return rows.map((row) =>
          toKey(
            { ...row, validity: AgentKeyValidity.parse(row.validity) },
            projects.get(row.id) ?? [],
          ),
        );
      });
    },

    async revokeKey(account, keyId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        const [owned] = await tx
          .select({ id: agentApiKeys.id })
          .from(agentApiKeys)
          .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
          .where(and(eq(agentApiKeys.id, keyId), eq(agents.humanId, actor.humanId)))
          .limit(1);
        if (owned === undefined) throw new AgentsError("key_not_found");
        return revokeInTransaction(tx, keyId, actor.humanId);
      });
    },

    async workspaceKeys(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        // The owner sees every key scoped to this workspace, whoever issued it. The
        // query never selects token_hash, so the secret cannot leak through this view.
        await requireWorkspaceOwner(tx, workspaceId, actor.humanId);
        const rows = await tx
          .select(keyRowColumns())
          .from(agentApiKeys)
          .where(eq(agentApiKeys.workspaceId, workspaceId));
        const projects = await loadKeyProjects(
          tx,
          rows.map((row) => row.id),
        );
        return rows.map((row) =>
          toKey(
            { ...row, validity: AgentKeyValidity.parse(row.validity) },
            projects.get(row.id) ?? [],
          ),
        );
      });
    },

    async ownerRevokeKey(account, workspaceId, keyId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireWorkspaceOwner(tx, workspaceId, actor.humanId);
        // The workspace predicate is part of the lookup: a key in another workspace is
        // not found here, so an owner cannot affect a human's keys elsewhere.
        const [found] = await tx
          .select({ id: agentApiKeys.id })
          .from(agentApiKeys)
          .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.workspaceId, workspaceId)))
          .limit(1);
        if (found === undefined) throw new AgentsError("key_not_found");
        return revokeInTransaction(tx, keyId, actor.humanId);
      });
    },

    async authenticate(token, target) {
      return db.transaction((tx) =>
        resolveKeyInTransaction(tx, projectAccessCeiling, token, target),
      );
    },
  };
}
