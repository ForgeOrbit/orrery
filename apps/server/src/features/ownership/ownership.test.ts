import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AgentKeyValidity,
  HistoryResponse,
  InstallationDirectoryResponse,
  OwnershipRecovery,
  Problem,
  ProjectAccessLevel,
  WorkspaceKind,
} from "@orrery/contract";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountRecoveryEvents,
  agentApiKeys,
  agents,
  humans,
  projectAccessGrants,
  projects,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import {
  createAccountsFeature,
  type AccountsFeature,
  type SessionAccount,
} from "../accounts/index.ts";
import { createFeatures } from "../index.ts";
import { createOwnershipService, type OwnershipService } from "./service.ts";
import type { OutgoingMail } from "../settings/index.ts";

const SECRET = "ownership-test-bootstrap-secret-123456";
const ADMIN_EMAIL = "ownership-admin@example.com";
const ADMIN_PASSWORD = "ownership-admin-password";
const PUBLIC_URL = "http://orrery.test";
const log = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let accounts: AccountsFeature;
let admin: SessionAccount;

function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row, got none");
  return row;
}

const postJson = (path: string, body: unknown, cookie?: string, bearer?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
const getJson = (path: string, cookie?: string, bearer?: string) =>
  app.request(path, {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

function cookieFrom(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((value) => value.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie was set");
  return cookie;
}

async function login(email: string, password: string): Promise<string> {
  const res = await postJson("/api/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login failed with ${res.status}`);
  return cookieFrom(res);
}

async function createHuman(email: string, password: string) {
  const humanId = await database.db.transaction(async (tx) => {
    const created = await accounts.createInvitedHuman({ email, password }, tx);
    await accounts.markEmailVerified(created.humanId, tx);
    return created.humanId;
  });
  return { humanId, email, cookie: await login(email, password) };
}

async function insertWorkspace(name: string, ownerHumanId: string, memberIds: string[] = []) {
  return database.db.transaction(async (tx) => {
    const workspace = one(
      await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: WorkspaceKind.enum.shared, name })
        .returning(),
    );
    await tx.insert(workspaceMemberships).values([
      { id: randomUUID(), workspaceId: workspace.id, humanId: ownerHumanId, isOwner: true },
      ...memberIds.map((humanId) => ({
        id: randomUUID(),
        workspaceId: workspace.id,
        humanId,
        isOwner: false,
      })),
    ]);
    return workspace;
  });
}

async function insertProject(workspaceId: string, createdByHumanId: string, name = "Secret Work") {
  return one(
    await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId,
        name,
        key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
        createdByHumanId,
      })
      .returning(),
  );
}

async function insertKey(humanId: string, workspaceId: string) {
  const agent = one(
    await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId, name: `agent-${randomUUID()}` })
      .returning(),
  );
  const secret = randomBytes(32).toString("base64url");
  await database.db.insert(agentApiKeys).values({
    id: randomUUID(),
    agentId: agent.id,
    workspaceId,
    createdByHumanId: humanId,
    validity: AgentKeyValidity.enum.never,
    tokenHash: tokenHash(secret),
  });
  return secret;
}

async function deactivate(humanId: string, cookie: string) {
  const res = await postJson(`/api/admin/accounts/${humanId}/deactivate`, {}, cookie);
  expect(res.status).toBe(200);
}
async function reactivate(humanId: string, cookie: string) {
  const res = await postJson(`/api/admin/accounts/${humanId}/reactivate`, {}, cookie);
  expect(res.status).toBe(200);
}

async function membership(workspaceId: string, humanId: string) {
  const [row] = await database.db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .limit(1);
  return row;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  const config = loadConfig({
    DATABASE_URL: pg.getConnectionUri(),
    PUBLIC_URL,
    BOOTSTRAP_SECRET: SECRET,
    LOG_LEVEL: "error",
  });
  database = createDb(config.DATABASE_URL);
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);
  accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  app = createApp({ features: createFeatures(database, config, log), publicUrl: PUBLIC_URL, log });

  const res = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (res.status !== 201) throw new Error(`bootstrap failed with ${res.status}`);
  const [row] = await database.db
    .select()
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL))
    .limit(1);
  if (row === undefined) throw new Error("bootstrap administrator was not stored");
  admin = {
    humanId: row.id,
    email: ADMIN_EMAIL,
    isSystemAdministrator: true,
    emailVerifiedAt: null,
  };
});

afterAll(async () => {
  await database.sql.end();
  await pg.stop();
});

describe("installation workspace directory (#43)", () => {
  it("returns identity, owners and membership status with no project content", async () => {
    const owner = await createHuman("dir.owner@example.com", "dir-owner-password");
    const member = await createHuman("dir.member@example.com", "dir-member-password");
    const workspace = await insertWorkspace("Directory Team", owner.humanId, [member.humanId]);
    const project = await insertProject(workspace.id, owner.humanId, "TOP SECRET PROJECT NAME");

    const res = await getJson("/api/admin/workspaces", await login(ADMIN_EMAIL, ADMIN_PASSWORD));
    expect(res.status).toBe(200);
    const body = InstallationDirectoryResponse.parse(await res.json());
    const entry = one(body.filter((row) => row.id === workspace.id));
    expect(entry).toMatchObject({
      id: workspace.id,
      name: "Directory Team",
      kind: "shared",
      hasActiveOwner: true,
    });
    expect(entry.members.map((row) => row.humanId)).toEqual(
      expect.arrayContaining([owner.humanId, member.humanId]),
    );
    const ownerRow = one(entry.members.filter((row) => row.humanId === owner.humanId));
    expect(ownerRow).toMatchObject({
      isOwner: true,
      isFormerOwner: false,
      suspendedAt: null,
      accountDeactivated: false,
    });

    expect(Object.keys(entry).toSorted()).toEqual([
      "createdAt",
      "hasActiveOwner",
      "id",
      "kind",
      "members",
      "name",
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("TOP SECRET PROJECT NAME");
    expect(serialized).not.toContain(project.id);
    expect(serialized).not.toContain('"projects"');
    expect(serialized).not.toContain('"projectId"');

    await deactivate(member.humanId, await login(ADMIN_EMAIL, ADMIN_PASSWORD));
    const after = InstallationDirectoryResponse.parse(
      await (
        await getJson("/api/admin/workspaces", await login(ADMIN_EMAIL, ADMIN_PASSWORD))
      ).json(),
    );
    const marked = one(
      one(after.filter((row) => row.id === workspace.id)).members.filter(
        (row) => row.humanId === member.humanId,
      ),
    );
    expect(marked.accountDeactivated).toBe(true);
    expect(marked.suspendedAt).not.toBeNull();
  });

  it("refuses non-administrators, unauthenticated callers and agent keys", async () => {
    const human = await createHuman("dir.nonadmin@example.com", "dir-nonadmin-password");
    await expectProblem(await getJson("/api/admin/workspaces"), 401, "not_signed_in");
    await expectProblem(
      await getJson("/api/admin/workspaces", human.cookie),
      403,
      "not_system_administrator",
    );

    const workspace = await insertWorkspace("Agent Key Probe", human.humanId);
    const secret = await insertKey(human.humanId, workspace.id);
    await expectProblem(
      await getJson("/api/admin/workspaces", undefined, secret),
      401,
      "not_signed_in",
    );

    expect(
      (await getJson("/api/admin/workspaces", await login(ADMIN_EMAIL, ADMIN_PASSWORD))).status,
    ).toBe(200);
  });
});

describe("ownership recovery refusals (#43)", () => {
  it("refuses while an active owner remains", async () => {
    const owner = await createHuman("active.owner@example.com", "active-owner-password");
    const member = await createHuman("active.member@example.com", "active-member-password");
    const workspace = await insertWorkspace("Still Owned", owner.humanId, [member.humanId]);
    const res = await postJson(
      `/api/admin/workspaces/${workspace.id}/recover-ownership`,
      { humanId: member.humanId },
      await login(ADMIN_EMAIL, ADMIN_PASSWORD),
    );
    await expectProblem(res, 409, "workspace_has_active_owner");
    expect((await membership(workspace.id, member.humanId))?.isOwner).toBe(false);
  });

  it("refuses self-promotion even when the administrator is an eligible member or former owner", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const owner = await createHuman("self.owner@example.com", "self-owner-password");
    const asMember = await insertWorkspace("Admin Member", owner.humanId, [admin.humanId]);
    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${asMember.id}/recover-ownership`,
        { humanId: admin.humanId },
        cookie,
      ),
      403,
      "self_recovery_forbidden",
    );

    const asFormerOwner = await database.db.transaction(async (tx) => {
      const workspace = one(
        await tx
          .insert(workspaces)
          .values({ id: randomUUID(), kind: WorkspaceKind.enum.shared, name: "Admin Former Owner" })
          .returning(),
      );
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: workspace.id,
        humanId: admin.humanId,
        isOwner: true,
      });
      return workspace;
    });
    await database.db
      .update(workspaceMemberships)
      .set({
        suspendedAt: sql`statement_timestamp()`,
        isFormerOwner: true,
        isOwner: false,
      })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, asFormerOwner.id),
          eq(workspaceMemberships.humanId, admin.humanId),
        ),
      );
    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${asFormerOwner.id}/recover-ownership`,
        { humanId: admin.humanId },
        cookie,
      ),
      403,
      "self_recovery_forbidden",
    );
    expect((await membership(asMember.id, admin.humanId))?.isOwner).toBe(false);
  });

  it("refuses a deactivated target, an outsider, a suspended non-former-owner and missing ids", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const owner = await createHuman("deact.owner@example.com", "deact-owner-password");
    const outsider = await createHuman("outsider@example.com", "outsider-password");
    const suspended = await createHuman("suspended.member@example.com", "suspended-password");
    const workspace = await insertWorkspace("Ownerless", owner.humanId, [suspended.humanId]);
    await database.db
      .update(workspaceMemberships)
      .set({ suspendedAt: sql`statement_timestamp()` })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspace.id),
          eq(workspaceMemberships.humanId, suspended.humanId),
        ),
      );
    await deactivate(owner.humanId, cookie);

    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${workspace.id}/recover-ownership`,
        { humanId: owner.humanId },
        cookie,
      ),
      409,
      "target_deactivated",
    );
    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${workspace.id}/recover-ownership`,
        { humanId: outsider.humanId },
        cookie,
      ),
      404,
      "member_not_found",
    );
    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${workspace.id}/recover-ownership`,
        { humanId: suspended.humanId },
        cookie,
      ),
      409,
      "recipient_ineligible",
    );
    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${workspace.id}/recover-ownership`,
        { humanId: randomUUID() },
        cookie,
      ),
      404,
      "human_not_found",
    );

    const personal = one(
      await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, outsider.humanId))
        .limit(1),
    );
    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${personal.id}/recover-ownership`,
        { humanId: suspended.humanId },
        cookie,
      ),
      404,
      "workspace_not_found",
    );
    await expectProblem(
      await postJson(
        `/api/admin/workspaces/${randomUUID()}/recover-ownership`,
        { humanId: suspended.humanId },
        cookie,
      ),
      404,
      "workspace_not_found",
    );
    expect((await membership(workspace.id, owner.humanId))?.suspendedAt).not.toBeNull();
  });
});

describe("successful ownership recovery (#43)", () => {
  it("promotes an active member after the sole owner is deactivated, and records both trails", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const owner = await createHuman("promote.owner@example.com", "promote-owner-password");
    const member = await createHuman("promote.member@example.com", "promote-member-password");
    const workspace = await insertWorkspace("Promote Member", owner.humanId, [member.humanId]);
    await deactivate(owner.humanId, cookie);

    const res = await postJson(
      `/api/admin/workspaces/${workspace.id}/recover-ownership`,
      { humanId: member.humanId },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(OwnershipRecovery.parse(await res.json())).toMatchObject({
      workspaceId: workspace.id,
      humanId: member.humanId,
    });

    const promoted = await membership(workspace.id, member.humanId);
    expect(promoted).toMatchObject({ isOwner: true, isFormerOwner: false, suspendedAt: null });
    expect((await membership(workspace.id, owner.humanId))?.suspendedAt).not.toBeNull();

    const [workspaceEvent] = await database.db
      .select()
      .from(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, workspace.id),
          eq(workspaceEvents.type, "workspace_ownership_recovered"),
        ),
      )
      .limit(1);
    expect(workspaceEvent?.actorHumanId).toBe(admin.humanId);
    expect(workspaceEvent?.subjectHumanId).toBe(member.humanId);
    const [accountEvent] = await database.db
      .select()
      .from(accountRecoveryEvents)
      .where(
        and(
          eq(accountRecoveryEvents.humanId, member.humanId),
          eq(accountRecoveryEvents.type, "workspace_ownership_recovered"),
        ),
      )
      .limit(1);
    expect(accountEvent?.actorHumanId).toBe(admin.humanId);

    const memberHistory = await getJson(`/api/workspaces/${workspace.id}/history`, member.cookie);
    expect(memberHistory.status).toBe(200);
    expect(HistoryResponse.parse(await memberHistory.json()).map((event) => event.type)).toContain(
      "workspace_ownership_recovered",
    );
    const installationHistory = await getJson("/api/installation/history", cookie);
    expect(installationHistory.status).toBe(200);
    const installationEvent = one(
      HistoryResponse.parse(await installationHistory.json()).filter(
        (event) => event.type === "workspace_ownership_recovered",
      ),
    );
    expect(installationEvent.actor.humanId).toBe(admin.humanId);

    expect(installationEvent.summary).toBeNull();
    expect(installationEvent.scope.kind).toBe("installation");
  });

  it("promotes the reactivated former sole owner, notifies members, and grants the administrator nothing", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const owner = await createHuman("sole.owner@example.com", "sole-owner-password");
    const member = await createHuman("sole.member@example.com", "sole-member-password");
    const workspace = await insertWorkspace("Sole Former Owner", owner.humanId, [member.humanId]);
    const project = await insertProject(workspace.id, owner.humanId, "Private Project");
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: project.id,
      humanId: owner.humanId,
      level: ProjectAccessLevel.enum.manage,
      grantedByHumanId: owner.humanId,
    });
    const oldKey = await insertKey(owner.humanId, workspace.id);
    await deactivate(owner.humanId, cookie);
    await reactivate(owner.humanId, cookie);

    const delivered: OutgoingMail[] = [];
    const service: OwnershipService = createOwnershipService({
      db: database.db,
      deliver: async (mail) => {
        delivered.push(mail);
      },
      log,
    });
    const result = await service.recoverOwnership(admin, workspace.id, owner.humanId);
    expect(result).toMatchObject({ workspaceId: workspace.id, humanId: owner.humanId });

    const promoted = await membership(workspace.id, owner.humanId);
    expect(promoted).toMatchObject({ isOwner: true, isFormerOwner: false, suspendedAt: null });

    expect(await membership(workspace.id, admin.humanId)).toBeUndefined();
    const [adminGrant] = await database.db
      .select()
      .from(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.humanId, admin.humanId),
          eq(projectAccessGrants.projectId, project.id),
        ),
      )
      .limit(1);
    expect(adminGrant).toBeUndefined();
    expect((await getJson(`/api/workspaces/${workspace.id}`, cookie)).status).toBe(404);

    const [key] = await database.db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.tokenHash, tokenHash(oldKey)))
      .limit(1);
    expect(key?.revokedAt).not.toBeNull();
    expect(
      await database.db
        .select()
        .from(projectAccessGrants)
        .where(eq(projectAccessGrants.humanId, owner.humanId))
        .limit(1),
    ).toEqual([]);

    expect(delivered.map((mail) => mail.to).toSorted()).toEqual(
      [member.email, owner.email].toSorted(),
    );
    expect(delivered[0]?.text).toContain("Sole Former Owner");
    expect(delivered[0]?.text).not.toContain(oldKey);
    expect(delivered[0]?.text).not.toContain("Private Project");

    const [workspaceEvent] = await database.db
      .select()
      .from(workspaceEvents)
      .where(
        and(
          eq(workspaceEvents.workspaceId, workspace.id),
          eq(workspaceEvents.type, "workspace_ownership_recovered"),
        ),
      )
      .limit(1);
    expect(workspaceEvent?.subjectHumanId).toBe(owner.humanId);
    const [stillActive] = await database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspace.id),
          eq(workspaceMemberships.isOwner, true),
          isNull(workspaceMemberships.suspendedAt),
        ),
      )
      .limit(1);
    expect(stillActive?.count).toBe(1);
  });

  it("keeps the recovery committed when the relay fails", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const owner = await createHuman("relay.owner@example.com", "relay-owner-password");
    const workspace = await insertWorkspace("Relay Failure", owner.humanId);
    await deactivate(owner.humanId, cookie);
    await reactivate(owner.humanId, cookie);

    const service = createOwnershipService({
      db: database.db,
      deliver: async () => {
        throw new Error("relay down");
      },
      log,
    });
    const result = await service.recoverOwnership(admin, workspace.id, owner.humanId);
    expect(result.humanId).toBe(owner.humanId);
    expect((await membership(workspace.id, owner.humanId))?.isOwner).toBe(true);
  });

  it("refuses a deactivated acting administrator inside the transaction", async () => {
    const secondAdmin = await createHuman("second.admin@example.com", "second-admin-password");
    await database.db
      .update(humans)
      .set({ isSystemAdministrator: true })
      .where(eq(humans.id, secondAdmin.humanId));
    const owner = await createHuman("deact.admin.owner@example.com", "owner-password");
    const workspace = await insertWorkspace("Deact Admin Check", owner.humanId);
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    await deactivate(owner.humanId, cookie);
    await reactivate(owner.humanId, cookie);
    await deactivate(secondAdmin.humanId, cookie);

    const staleAdmin = {
      humanId: secondAdmin.humanId,
      email: secondAdmin.email,
      emailVerifiedAt: new Date(),
      isSystemAdministrator: true,
    };
    const service = createOwnershipService({
      db: database.db,
      deliver: async () => {},
      log,
    });
    await expect(service.directory(staleAdmin)).rejects.toMatchObject({
      kind: "not_system_administrator",
    });
    await expect(
      service.recoverOwnership(staleAdmin, workspace.id, owner.humanId),
    ).rejects.toMatchObject({
      kind: "not_system_administrator",
    });
  });
});
