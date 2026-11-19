import {
  Issue,
  IssueComment,
  KnowledgeEntry,
  Project,
  type CreateIssueCommentRequest,
  type CreateIssueRequest,
  type CreateKnowledgeEntryRequest,
  type CreateProjectRequest,
  type UpdateIssueRequest,
  type UpdateKnowledgeEntryRequest,
} from "@orrery/contract";
import { patchJson, postJson } from "../../lib/api.ts";

// Mutations for this feature. Each goes through the app's one request helper, which
// parses the response with the contract's schemas and turns a Problem (RFC 9457)
// response into a plain Error carrying its most specific human text.

export function createProject(workspaceId: string, input: CreateProjectRequest): Promise<Project> {
  return postJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, input, (value) =>
    Project.parse(value),
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

export function createIssueComment(
  issueId: string,
  input: CreateIssueCommentRequest,
): Promise<IssueComment> {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, input, (value) =>
    IssueComment.parse(value),
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
