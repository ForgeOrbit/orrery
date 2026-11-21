import {
  Issue,
  IssueComment,
  IssueDependency,
  IssueLink,
  KnowledgeEntry,
  Project,
  ProjectAccessGrant,
  ProjectLabel,
  type CreateIssueCommentRequest,
  type CreateIssueLinkRequest,
  type CreateIssueRequest,
  type CreateKnowledgeEntryRequest,
  type CreateProjectLabelRequest,
  type CreateProjectRequest,
  type SetProjectAccessRequest,
  type UpdateIssueRequest,
  type UpdateKnowledgeEntryRequest,
  type UpdateProjectLabelRequest,
  type UpdateProjectRequest,
} from "@orrery/contract";
import { deleteJson, deleteRequest, patchJson, postJson } from "../../lib/api.ts";

// Mutations for this feature. Each goes through the app's one request helper, which
// parses the response with the contract's schemas and turns a Problem (RFC 9457)
// response into a plain Error carrying its most specific human text.

export function createProject(workspaceId: string, input: CreateProjectRequest): Promise<Project> {
  return postJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, input, (value) =>
    Project.parse(value),
  );
}

// A project manager's project setting: the name. The server checks Manage and records the
// rename in the project's activity.
export function updateProject(projectId: string, input: UpdateProjectRequest): Promise<Project> {
  return patchJson(`/api/projects/${encodeURIComponent(projectId)}`, input, (value) =>
    Project.parse(value),
  );
}

// Grants or changes one workspace member's project level. Manage only; the server
// resolves the member by email inside the project's workspace.
export function setProjectAccess(
  projectId: string,
  input: SetProjectAccessRequest,
): Promise<ProjectAccessGrant> {
  return patchJson(`/api/projects/${encodeURIComponent(projectId)}/access`, input, (value) =>
    ProjectAccessGrant.parse(value),
  );
}

// Revokes a grant. The server makes this idempotent, so a stale page does not fail.
export function removeProjectAccess(projectId: string, humanId: string): Promise<void> {
  return deleteRequest(
    `/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(humanId)}`,
  );
}

export function createIssue(projectId: string, input: CreateIssueRequest): Promise<Issue> {
  return postJson(`/api/projects/${encodeURIComponent(projectId)}/issues`, input, (value) =>
    Issue.parse(value),
  );
}

export function updateIssue(issueId: string, input: UpdateIssueRequest): Promise<Issue> {
  return patchJson(`/api/issues/${encodeURIComponent(issueId)}`, input, (value) =>
    Issue.parse(value),
  );
}

// #98: a human with Contribute or Manage moves an unclaimed issue to the project's trash.
// Agents have no route here, and the server refuses an issue with a live session.
export function deleteIssue(issueId: string): Promise<void> {
  return deleteRequest(`/api/issues/${encodeURIComponent(issueId)}`);
}

// Restore is Manage-only and limited to the 30-day window; the server owns both rules.
export function restoreIssue(issueId: string): Promise<Issue> {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/restore`, {}, (value) =>
    Issue.parse(value),
  );
}

// #97: project label metadata. Contribute may create, rename, recolor and delete; the
// server enforces the level and the project's case-insensitive name uniqueness.
export function createProjectLabel(
  projectId: string,
  input: CreateProjectLabelRequest,
): Promise<ProjectLabel> {
  return postJson(`/api/projects/${encodeURIComponent(projectId)}/labels`, input, (value) =>
    ProjectLabel.parse(value),
  );
}

export function updateProjectLabel(
  labelId: string,
  input: UpdateProjectLabelRequest,
): Promise<ProjectLabel> {
  return patchJson(`/api/labels/${encodeURIComponent(labelId)}`, input, (value) =>
    ProjectLabel.parse(value),
  );
}

export function deleteProjectLabel(labelId: string): Promise<void> {
  return deleteRequest(`/api/labels/${encodeURIComponent(labelId)}`);
}

// Attaching and detaching return the issue so a page can replace its cache entry without
// a second read; a repeated attach or detach is a server-side no-op.
export function attachIssueLabel(issueId: string, labelId: string): Promise<Issue> {
  return postJson(
    `/api/issues/${encodeURIComponent(issueId)}/labels/${encodeURIComponent(labelId)}`,
    {},
    (value) => Issue.parse(value),
  );
}

export function detachIssueLabel(issueId: string, labelId: string): Promise<Issue> {
  return deleteJson(
    `/api/issues/${encodeURIComponent(issueId)}/labels/${encodeURIComponent(labelId)}`,
    (value) => Issue.parse(value),
  );
}

// Depended-on issue ids are never invented here: the server resolves both issues,
// enforces same-project scope and acyclicity, and turns a bad edge into a Problem.
export function addBlockedBy(issueId: string, blockedByIssueId: string): Promise<IssueDependency> {
  return postJson(
    `/api/issues/${encodeURIComponent(issueId)}/blocked-by`,
    { blockedByIssueId },
    (value) => IssueDependency.parse(value),
  );
}

export function removeBlockedBy(issueId: string, blockedByIssueId: string): Promise<void> {
  return deleteRequest(
    `/api/issues/${encodeURIComponent(issueId)}/blocked-by/${encodeURIComponent(blockedByIssueId)}`,
  );
}

export function createIssueComment(
  issueId: string,
  input: CreateIssueCommentRequest,
): Promise<IssueComment> {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, input, (value) =>
    IssueComment.parse(value),
  );
}

export function addIssueLink(issueId: string, input: CreateIssueLinkRequest): Promise<IssueLink> {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/links`, input, (value) =>
    IssueLink.parse(value),
  );
}

export function removeIssueLink(issueId: string, linkId: string): Promise<void> {
  return deleteRequest(
    `/api/issues/${encodeURIComponent(issueId)}/links/${encodeURIComponent(linkId)}`,
  );
}

export function createKnowledgeEntry(
  projectId: string,
  input: CreateKnowledgeEntryRequest,
): Promise<KnowledgeEntry> {
  return postJson(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, input, (value) =>
    KnowledgeEntry.parse(value),
  );
}

export function updateKnowledgeEntry(
  entryId: string,
  input: UpdateKnowledgeEntryRequest,
): Promise<KnowledgeEntry> {
  return patchJson(`/api/knowledge/${encodeURIComponent(entryId)}`, input, (value) =>
    KnowledgeEntry.parse(value),
  );
}
