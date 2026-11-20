import {
  Issue,
  IssueCommentsResponse,
  IssuesResponse,
  KnowledgeEntriesResponse,
  KnowledgeEntry,
  Project,
  ProjectAccessGrantsResponse,
  ProjectActivityResponse,
  ProjectsResponse,
} from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

// Query definitions for this feature, shared by routes and components so they use one
// cache key. Responses are parsed with the contract's zod schemas, so a server change
// can't slip through.

export const projectsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "projects"],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, (value) =>
        ProjectsResponse.parse(value),
      ),
  });

export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}`, (value) => Project.parse(value)),
  });

export const projectAccessQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "access"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/access`, (value) =>
        ProjectAccessGrantsResponse.parse(value),
      ),
  });

export const issuesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "issues"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/issues`, (value) =>
        IssuesResponse.parse(value),
      ),
  });

export const issueQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}`, (value) => Issue.parse(value)),
  });

// A relation resolves to the related issues, so the page can show each blocker's current
// status without a second shape. Read access is enough for both directions.
export const issueBlockedByQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "blocked-by"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/blocked-by`, (value) =>
        IssuesResponse.parse(value),
      ),
  });

export const issueBlockingQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "blocking"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/blocking`, (value) =>
        IssuesResponse.parse(value),
      ),
  });

export const issueCommentsQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "comments"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, (value) =>
        IssueCommentsResponse.parse(value),
      ),
  });

export const projectActivityQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "activity"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/activity`, (value) =>
        ProjectActivityResponse.parse(value),
      ),
  });

export const knowledgeEntriesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "knowledge"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, (value) =>
        KnowledgeEntriesResponse.parse(value),
      ),
  });

export const knowledgeEntryQuery = (entryId: string) =>
  queryOptions({
    queryKey: ["knowledge", entryId],
    queryFn: () =>
      getJson(`/api/knowledge/${encodeURIComponent(entryId)}`, (value) =>
        KnowledgeEntry.parse(value),
      ),
  });
