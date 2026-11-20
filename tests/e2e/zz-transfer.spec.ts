// Personal-to-shared project transfer (issue #39), black-box against the running
// installation. The admin owns a personal project and the shared destination, so one
// person holds both authorities and completes the move directly. Afterwards a personal
// API key is refused on the moved project while the destination owner still has Manage
// and sees the preserved project, issues and history. No server code is imported.
//
// The `zz-` prefix runs this with the other late suites. It needs no mail delivery.
//
//   docker compose --profile mail-test up -d --build --wait
//   ORRERY_URL=http://localhost:8080 pnpm test:e2e
import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);

function stringsOf(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => {
    const fieldValue = field(item, key);
    return typeof fieldValue === "string" ? [fieldValue] : [];
  });
}

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "the personal workspace");
}

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
});

test("moves a personal project into a shared workspace and leaves source keys behind", async () => {
  const personalWorkspaceId = await personalWorkspaceOf(api);
  const suffix = randomUUID().slice(0, 8);

  const projectRes = await api.post(`/api/workspaces/${personalWorkspaceId}/projects`, {
    data: { name: `Transfer Preview ${suffix}` },
  });
  expect(projectRes.status()).toBe(201);
  const project = await projectRes.json();
  const projectId = idOf(project, "project");
  expect(project).toMatchObject({
    workspaceId: personalWorkspaceId,
    createdBy: { email: ADMIN_EMAIL },
  });

  const issueRes = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: `Preserved issue ${suffix}` },
  });
  expect(issueRes.status()).toBe(201);
  const issueId = idOf(await issueRes.json(), "issue");

  const agentRes = await api.post("/api/agents", { data: { name: `transfer-agent-${suffix}` } });
  expect(agentRes.status()).toBe(201);
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId: idOf(await agentRes.json(), "agent"),
      workspaceId: personalWorkspaceId,
      validity: "7",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const secret = requiredText(field(await keyRes.json(), "secret"), "the key secret");
  await recordSecret(secret);

  const destinationRes = await api.post("/api/workspaces", {
    data: { name: `Transfer Destination ${suffix}` },
  });
  expect(destinationRes.status()).toBe(201);
  const destinationWorkspaceId = idOf(await destinationRes.json(), "destination workspace");

  // The one person with both authorities previews the access change, then completes it.
  const previewRes = await api.post(`/api/projects/${projectId}/transfer/preview`, {
    data: { destinationWorkspaceId },
  });
  expect(previewRes.status()).toBe(200);
  const preview: unknown = await previewRes.json();
  expect(preview).toMatchObject({
    projectId,
    visibilityChange: "personal_to_shared",
    destination: { workspaceId: destinationWorkspaceId, kind: "shared" },
  });
  expect(stringsOf(field(preview, "accessChanges"), "reason")).toContain("destination_owner");

  const completeRes = await api.post(`/api/projects/${projectId}/transfer/complete`, {
    data: { destinationWorkspaceId },
  });
  expect(completeRes.status()).toBe(200);
  expect(await completeRes.json()).toMatchObject({
    id: projectId,
    workspaceId: destinationWorkspaceId,
    workspaceKind: "shared",
    accessLevel: "manage",
  });

  // The source key is refused: a bearer request has no view of the moved project.
  const keyOnly = await fetch(new URL(`/api/projects/${projectId}`, baseUrl), {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(keyOnly.status).toBeGreaterThanOrEqual(400);

  // The destination owner keeps Manage and the preserved issue and activity history.
  const after = await api.get(`/api/projects/${projectId}`);
  expect(after.status()).toBe(200);
  expect(await after.json()).toMatchObject({ id: projectId, accessLevel: "manage" });

  const issues = await api.get(`/api/projects/${projectId}/issues`);
  expect(issues.status()).toBe(200);
  expect(stringsOf(await issues.json(), "id")).toContain(issueId);

  const activity = await api.get(`/api/projects/${projectId}/activity`);
  expect(activity.status()).toBe(200);
  expect(stringsOf(await activity.json(), "type")).toContain("issue_created");

  // Owners hold Manage implicitly and are not listed as explicit grants; the project
  // view above is the owner's Manage proof. The access feed still shows the grant events.
  const grants = await api.get(`/api/projects/${projectId}/access`);
  expect(grants.status()).toBe(200);
  expect(Array.isArray(await grants.json())).toBe(true);

  const history = await api.get(`/api/projects/${projectId}/history`);
  expect(history.status()).toBe(200);
  expect(stringsOf(await history.json(), "type")).toContain("project_access_granted");
});
