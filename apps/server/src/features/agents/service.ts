import { randomBytes, randomUUID } from "node:crypto";
import {
  AgentKeyEventType,
  AgentKeyValidity,
  ProjectAccessLevel,
  type Agent,
  type AgentIdentity,
  type AgentKey,
  type AgentKeyGrant,
  type AgentKeyProject,
  type CreateAgentKeyRequest,
  type CreateAgentKeyResponse,
  type CreateAgentRequest,
  type RotateAgentKeyRequest,
} from "@orrery/contract";
import { and, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { uniqueConstraintName } from "../../platform/errors.ts";
import { tokenHash } from "../../platform/tokens.ts";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agentKeyEvents,
  agents,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { canAuthenticateKey, canRotateKey, effectiveAgentKeyState } from "./state-machine.ts";

// The service is the only file in this feature that decides anything. rest.ts validates
// and maps results; every rule about who may act, which workspace a key can reach, and
// how a human's current access caps an agent lives here. Project level ranking is the
// projects feature's, not a second copy here.

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

// Each key computes its own expiry when it is created, in database time. Rotation uses
// the same helper as issuance, so a replacement's deadline is independent of the source
// key's deadline and of the source key's later revocation (#35).
function expiryFor(validity: AgentKeyValidity) {
  return validity === AgentKeyValidity.enum.never
    ? null
    : sql`now() + make_interval(days => ${VALIDITY_DAYS[validity]})`;
}

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
  | "key_workspace_inaccessible"
  | "key_out_of_scope"
  | "insufficient_agent_access"
  | "source_key_revoked"
  | "source_key_expired";

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
  key_workspace_inaccessible: "The human who owns this key can no longer use its workspace.",
  key_out_of_scope: "The API key is not scoped to this workspace.",
  insufficient_agent_access: "The agent has no access to this project.",
  source_key_revoked: "A revoked key cannot be rotated.",
  source_key_expired: "An expired key cannot be rotated.",
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

// A missing bearer credential is an authentication decision, so it belongs here beside
// requireAccount: rest.ts only reads the header and passes what it found.
function requireKey(token: string | null): string {
  if (token === null) throw new AgentsError("invalid_key");
  return token;
}

// Issuing a key takes the same installation-wide ownership write lock as project access
// and workspace membership changes, and takes it first: no row lock comes before it.
// Without it, a concurrent member removal could run its revocation UPDATE before this
// key's INSERT committed, leaving an unrevoked key for a member who is already gone.
async function lockWorkspaceOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

// A project ceiling decided by the projects feature's one resolver, borrowed through
// the feature's public interface. Agents never grow a second project-level policy.
export type ProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export type ProjectAccessAtLeast = (
  actual: ProjectAccessLevel,
  required: ProjectAccessLevel,
) => boolean;

// Both resolvers are borrowed through the feature registry, so agents never imports a
// projects internal file and projects remains free to own the one ranking rule.
export interface AgentsDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: ProjectAccessCeiling;
  projectAccessAtLeast: ProjectAccessAtLeast;
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
  // Rotation creates an overlapping replacement for one of the human's own keys. The
  // secret is returned once here; the source key's secret is never read or exposed.
  rotateKey(
    account: SessionAccount | null,
    keyId: string,
    input: RotateAgentKeyRequest,
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
  authenticate(token: string | null, target?: AgentKeyTarget): Promise<AgentIdentity>;
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
  if (row === undefined) return false;
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
  agentName: string;
  workspaceId: string;
  createdByHumanId: string;
  validity: AgentKeyValidity;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByHumanId: string | null;
  replacesKeyId: string | null;
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
    replacesKeyId: agentApiKeys.replacesKeyId,
  };
}

function toKey(row: KeyRow, grants: AgentKeyProject[]): AgentKey {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    workspaceId: row.workspaceId,
    createdByHumanId: row.createdByHumanId,
    validity: AgentKeyValidity.parse(row.validity),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByHumanId: row.revokedByHumanId,
    replacesKeyId: row.replacesKeyId,
    projects: grants,
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
      projectName: projects.name,
      level: agentApiKeyProjects.level,
    })
    .from(agentApiKeyProjects)
    .innerJoin(projects, eq(projects.id, agentApiKeyProjects.projectId))
    .where(inArray(agentApiKeyProjects.keyId, [...keyIds]));
  for (const row of rows) {
    const list = byKey.get(row.keyId) ?? [];
    list.push({
      projectId: row.projectId,
      projectName: row.projectName,
      level: ProjectAccessLevel.parse(row.level),
    });
    byKey.set(row.keyId, list);
  }
  return byKey;
}

// Keys and their grants are always loaded together, with readable names: an owner
// listing another human's keys needs the agent and project names, not raw ids.
async function loadKeys(tx: DbTransaction, where: SQL | undefined): Promise<AgentKey[]> {
  const rows = await tx
    .select({ ...keyRowColumns(), agentName: agents.name })
    .from(agentApiKeys)
    .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
    .where(where);
  const projectsByKey = await loadKeyProjects(
    tx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toKey(row, projectsByKey.get(row.id) ?? []));
}

async function projectKey(tx: DbTransaction, keyId: string): Promise<AgentKey> {
  const [key] = await loadKeys(tx, eq(agentApiKeys.id, keyId));
  if (key === undefined) throw new AgentsError("key_not_found");
  return key;
}

// Revoke in database time and write the event in one transaction. Both the human owner
// and a workspace owner go through this, so revocation has one implementation; only the
// authorization and the workspace scope differ. The conditional update plus RETURNING
// makes retries idempotent: an already-revoked key changes nothing and writes no second
// audit event.
async function revokeInTransaction(
  tx: DbTransaction,
  keyId: string,
  actorHumanId: string,
): Promise<AgentKey> {
  const updated = await tx
    .update(agentApiKeys)
    .set({ revokedAt: sql`now()`, revokedByHumanId: actorHumanId })
    .where(and(eq(agentApiKeys.id, keyId), isNull(agentApiKeys.revokedAt)))
    .returning({ id: agentApiKeys.id });
  const key = await projectKey(tx, keyId);
  if (updated.length > 0) {
    await recordEvent(
      tx,
      AgentKeyEventType.enum.agent_key_revoked,
      { id: key.id, agentId: key.agentId, workspaceId: key.workspaceId },
      actorHumanId,
    );
  }
  return key;
}

// Membership removal ends every key the removed human's agents hold in that workspace,
// inside the removal's own transaction. agentApiKeys belongs to this feature, so the
// workspaces feature borrows this helper through the registry instead of writing to the
// key table itself. The conditional UPDATE ... RETURNING makes it idempotent: a key that
// was already revoked (by its owner or an owner) changes nothing and writes no second
// event. One secret-free event is recorded per newly revoked key, with the remover as
// actor — the same audit shape as any other revocation.
export async function revokeMemberWorkspaceKeys(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  actorHumanId: string,
): Promise<void> {
  const revoked = await tx
    .update(agentApiKeys)
    .set({ revokedAt: sql`now()`, revokedByHumanId: actorHumanId })
    .where(
      and(
        eq(agentApiKeys.workspaceId, workspaceId),
        isNull(agentApiKeys.revokedAt),
        inArray(
          agentApiKeys.agentId,
          tx.select({ id: agents.id }).from(agents).where(eq(agents.humanId, humanId)),
        ),
      ),
    )
    .returning({ id: agentApiKeys.id, agentId: agentApiKeys.agentId });

  for (const key of revoked) {
    await recordEvent(
      tx,
      AgentKeyEventType.enum.agent_key_revoked,
      { id: key.id, agentId: key.agentId, workspaceId },
      actorHumanId,
    );
  }
}

// Bearer resolution inside one transaction: the lookup, the revocation/expiry/activity
// checks, the dynamic human-access ceiling, and the optional target scope all see one
// consistent snapshot.
async function resolveKeyInTransaction(
  tx: DbTransaction,
  projectAccessCeiling: ProjectAccessCeiling,
  projectAccessAtLeast: ProjectAccessAtLeast,
  token: string,
  target?: AgentKeyTarget,
): Promise<AgentIdentity> {
  const [row] = await tx
    .select({
      key: keyRowColumns(),
      agentName: agents.name,
      humanId: agents.humanId,
    })
    .from(agentApiKeys)
    .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
    .where(eq(agentApiKeys.tokenHash, tokenHash(token)))
    .limit(1);
  if (row === undefined) throw new AgentsError("invalid_key");

  // Revocation wins over everything, including "Never": it is checked on every request
  // and takes effect immediately, independently of any connection state.
  if (row.key.revokedAt !== null) {
    effectiveAgentKeyState({
      revokedAt: row.key.revokedAt,
      validity: AgentKeyValidity.parse(row.key.validity),
      expired: false,
    });
    throw new AgentsError("key_revoked");
  }

  // Membership is an access check, not a transport detail: removing the human from the
  // key's workspace stops the key immediately, even a Never key with no project grants.
  if (!(await humanCanUseWorkspace(tx, row.key.workspaceId, row.humanId))) {
    throw new AgentsError("key_workspace_inaccessible");
  }

  // Expiry is evaluated in database time. "Never" has a null expiry and skips only this
  // check; it is still subject to revocation, membership, and every access check.
  if (AgentKeyValidity.parse(row.key.validity) !== AgentKeyValidity.enum.never) {
    const [live] = await tx
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.id, row.key.id), gt(agentApiKeys.expiresAt, sql`now()`)))
      .limit(1);
    const keyState = effectiveAgentKeyState({
      revokedAt: null,
      validity: AgentKeyValidity.parse(row.key.validity),
      expired: live === undefined,
    });
    if (!canAuthenticateKey(keyState)) throw new AgentsError("key_expired");
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
      projectName: grant.projectName,
      level: projectAccessAtLeast(humanLevel, grant.level) ? grant.level : humanLevel,
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

export function createAgentsService({
  db,
  projectAccessCeiling,
  projectAccessAtLeast,
}: AgentsDeps): AgentsService {
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
        // Serialize with member removal and every other ownership write. The lock is
        // taken before any row is read or written, matching projects and workspaces.
        await lockWorkspaceOwnershipWrites(tx);
        const [agent] = await tx
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.humanId, actor.humanId)))
          .limit(1);
        if (agent === undefined) throw new AgentsError("agent_not_found");

        if (!(await humanCanUseWorkspace(tx, input.workspaceId, actor.humanId))) {
          throw new AgentsError("workspace_not_found");
        }

        // The human's current access is the ceiling at issuance as well: the key cannot
        // be created above it, so a later promotion cannot silently raise an old key.
        // At authentication the same ceiling is re-evaluated, so a demotion or removal
        // still caps the agent immediately without reissuing the key.
        const requested = input.projects;
        const ceiling = await projectAccessCeiling(
          tx,
          input.workspaceId,
          actor.humanId,
          requested.map((grant) => grant.projectId),
        );
        for (const grant of requested) {
          const humanLevel = ceiling.get(grant.projectId);
          if (
            humanLevel === undefined ||
            humanLevel === null ||
            !projectAccessAtLeast(humanLevel, grant.level)
          ) {
            throw new AgentsError("invalid_key_grant");
          }
        }

        const secret = newSecret();
        const id = randomUUID();
        const [inserted] = await tx
          .insert(agentApiKeys)
          .values({
            id,
            agentId: agent.id,
            workspaceId: input.workspaceId,
            createdByHumanId: actor.humanId,
            validity,
            tokenHash: tokenHash(secret),
            expiresAt: expiryFor(validity),
          })
          .returning(keyRowColumns());
        if (inserted === undefined) throw new AgentsError("invalid_key_grant");
        const row = { ...inserted, agentName: agent.name };

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
        const stored = await loadKeyProjects(tx, [id]);
        return { key: toKey(row, stored.get(id) ?? []), secret };
      });
    },

    async rotateKey(account, keyId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        // Rotation writes a new key and reads the human's current grants, so it takes
        // the same installation-wide ownership lock as issuance and takes it first. A
        // member removal cannot slip its revocation between this transaction's reads
        // and the replacement's INSERT (#35, matching issueKey).
        await lockWorkspaceOwnershipWrites(tx);

        // The source must be one of the human's own keys. Joining through the agent
        // makes another human's key indistinguishable from a missing one: an id alone
        // is not authority to mint a replacement.
        const [source] = await tx
          .select({ key: keyRowColumns(), agentName: agents.name })
          .from(agentApiKeys)
          .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
          .where(and(eq(agentApiKeys.id, keyId), eq(agents.humanId, actor.humanId)))
          .limit(1);
        if (source === undefined) throw new AgentsError("key_not_found");

        // Both keys must be live at the moment of rotation, otherwise "overlap" would
        // be a lie. A revoked key is refused outright; an expired one is checked in
        // database time even if no sweeper has stamped it. The check is about the
        // source's own state, independent of the requested replacement validity.
        const sourceValidity = AgentKeyValidity.parse(source.key.validity);
        let sourceExpired = false;
        if (source.key.revokedAt !== null) {
          effectiveAgentKeyState({
            revokedAt: source.key.revokedAt,
            validity: sourceValidity,
            expired: false,
          });
          throw new AgentsError("source_key_revoked");
        }
        if (sourceValidity !== AgentKeyValidity.enum.never) {
          const [live] = await tx
            .select({ id: agentApiKeys.id })
            .from(agentApiKeys)
            .where(and(eq(agentApiKeys.id, keyId), gt(agentApiKeys.expiresAt, sql`now()`)))
            .limit(1);
          sourceExpired = live === undefined;
        }
        const sourceState = effectiveAgentKeyState({
          revokedAt: source.key.revokedAt,
          validity: sourceValidity,
          expired: sourceExpired,
        });
        if (!canRotateKey(sourceState)) throw new AgentsError("source_key_expired");

        // A key whose human owner can no longer use its workspace cannot be the source
        // of a fresh credential for that workspace.
        if (!(await humanCanUseWorkspace(tx, source.key.workspaceId, actor.humanId))) {
          throw new AgentsError("workspace_not_found");
        }

        // Grants: an explicit list is validated exactly like issuance (a project above
        // the human's current access is refused). Omitted grants are preserved from
        // the source but re-capped by the human's *current* access: a level that was
        // lowered is clamped, and a grant whose project is no longer reachable is
        // dropped. Removed authority can never be carried into the replacement.
        const preserved = (await loadKeyProjects(tx, [keyId])).get(keyId) ?? [];
        const requested: AgentKeyGrant[] =
          input.projects ??
          preserved.map((grant) => ({ projectId: grant.projectId, level: grant.level }));
        const explicit = input.projects !== undefined;
        const ceiling = await projectAccessCeiling(
          tx,
          source.key.workspaceId,
          actor.humanId,
          requested.map((grant) => grant.projectId),
        );
        const grants: AgentKeyGrant[] = [];
        for (const grant of requested) {
          const humanLevel = ceiling.get(grant.projectId);
          if (humanLevel === undefined || humanLevel === null) {
            if (explicit) throw new AgentsError("invalid_key_grant");
            continue;
          }
          if (!projectAccessAtLeast(humanLevel, grant.level)) {
            if (explicit) throw new AgentsError("invalid_key_grant");
            grants.push({ projectId: grant.projectId, level: humanLevel });
          } else {
            grants.push(grant);
          }
        }

        // A new secret, a new id, and a new expiry computed from now(). The source
        // key's hash is never selected, so its secret cannot be repeated here.
        const validity = input.validity ?? AgentKeyValidity.parse(source.key.validity);
        const secret = newSecret();
        const id = randomUUID();
        const [inserted] = await tx
          .insert(agentApiKeys)
          .values({
            id,
            agentId: source.key.agentId,
            workspaceId: source.key.workspaceId,
            createdByHumanId: actor.humanId,
            validity,
            tokenHash: tokenHash(secret),
            expiresAt: expiryFor(validity),
            replacesKeyId: keyId,
          })
          .returning(keyRowColumns());
        if (inserted === undefined) throw new AgentsError("invalid_key_grant");
        const row = { ...inserted, agentName: source.agentName };

        if (grants.length > 0) {
          await tx.insert(agentApiKeyProjects).values(
            grants.map((grant) => ({
              id: randomUUID(),
              keyId: id,
              projectId: grant.projectId,
              level: grant.level,
            })),
          );
        }
        // One secret-free rotation event on the replacement key. Its replacesKeyId
        // column names the source; no secret or hash is read, stored, or returned here.
        await recordEvent(
          tx,
          AgentKeyEventType.enum.agent_key_rotated,
          { id, agentId: source.key.agentId, workspaceId: source.key.workspaceId },
          actor.humanId,
        );
        const stored = await loadKeyProjects(tx, [id]);
        return { key: toKey(row, stored.get(id) ?? []), secret };
      });
    },

    async listKeys(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction((tx) =>
        loadKeys(
          tx,
          workspaceId === undefined
            ? eq(agents.humanId, actor.humanId)
            : and(eq(agents.humanId, actor.humanId), eq(agentApiKeys.workspaceId, workspaceId)),
        ),
      );
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
        return loadKeys(tx, eq(agentApiKeys.workspaceId, workspaceId));
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
      const presented = requireKey(token);
      // Authentication is a read-only decision over several tables (the key, its
      // revocation, the human's membership, expiry, and the project ceiling). One
      // REPEATABLE READ snapshot keeps those reads consistent instead of letting a
      // concurrent revoke, removal, or demotion tear the decision apart mid-flight.
      return db.transaction(
        (tx) =>
          resolveKeyInTransaction(
            tx,
            projectAccessCeiling,
            projectAccessAtLeast,
            presented,
            target,
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
