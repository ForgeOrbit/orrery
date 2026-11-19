import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  CreateIssueCommentRequest,
  CreateIssueRequest,
  CreateKnowledgeEntryRequest,
  CreateProjectRequest,
  Issue,
  IssueComment,
  IssueCommentsResponse,
  IssuesResponse,
  KnowledgeEntriesResponse,
  KnowledgeEntry,
  Project,
  ProjectActivityResponse,
  ProjectsResponse,
  UpdateIssueRequest,
  UpdateKnowledgeEntryRequest,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { ProjectsError, type ProjectsErrorKind, type ProjectsService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const projectParams = z.object({ projectId: z.string().min(1).max(200) });
const issueParams = z.object({ issueId: z.string().min(1).max(200) });
const knowledgeParams = z.object({ entryId: z.string().min(1).max(200) });

const listProjects = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/projects",
  summary: "The projects in the caller's personal workspace",
  description:
    "A personal workspace's owner sees its projects. Projects are personal in this release; a shared workspace has no project surface yet (#27). A workspace outside the caller's personal ownership answers exactly like a missing one.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The projects in the personal workspace",
      content: { "application/json": { schema: ProjectsResponse } },
    },
    400: problem("The workspace id is invalid"),
    401: problem("Not signed in"),
    404: problem("No personal workspace with this id is accessible to the caller"),
  },
});

const createProject = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/projects",
  summary: "Create a project in the caller's personal workspace",
  description:
    "The personal workspace's owner creates a project. Projects are personal in this release; a shared workspace has no project surface yet (#27). The project belongs to the workspace; its creator is recorded as authorship. The creation is recorded in the project's activity.",
  request: {
    params: workspaceParams,
    body: { required: true, content: { "application/json": { schema: CreateProjectRequest } } },
  },
  responses: {
    201: {
      description: "The project, created in the personal workspace",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No personal workspace with this id is accessible to the caller"),
  },
});

const getProject = createRoute({
  method: "get",
  path: "/api/projects/{projectId}",
  summary: "One project the caller can access",
  description:
    "A project's own view. A project outside the caller's access answers exactly like a missing one, so ids cannot be enumerated.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listIssues = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/issues",
  summary: "The issues in a project",
  description: "Every issue in the project, oldest number first, with its author and last editor.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's issues",
      content: { "application/json": { schema: IssuesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const createIssue = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/issues",
  summary: "Create an issue in a project",
  description:
    "The issue gets the project's next local number, starts open, and records its creator. The creation is recorded in the project's activity.",
  request: {
    params: projectParams,
    body: { required: true, content: { "application/json": { schema: CreateIssueRequest } } },
  },
  responses: {
    201: {
      description: "The issue, open",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const getIssue = createRoute({
  method: "get",
  path: "/api/issues/{issueId}",
  summary: "One issue the caller can access",
  description: "The issue's title, Markdown body, status, and authorship.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The issue id is invalid"),
    401: problem("Not signed in"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const updateIssue = createRoute({
  method: "patch",
  path: "/api/issues/{issueId}",
  summary: "Edit, close, or reopen an issue",
  description:
    "Every field is optional. A title or body change records an edit; a status change records a close or a reopen. A request that changes nothing returns the issue unchanged and records no event.",
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: UpdateIssueRequest } } },
  },
  responses: {
    200: {
      description: "The issue after the change",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listComments = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/comments",
  summary: "The comments on an issue",
  description: "The issue's comments in the order they were written, each with its author.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue's comments",
      content: { "application/json": { schema: IssueCommentsResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem("Not signed in"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const createComment = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/comments",
  summary: "Comment on an issue",
  description:
    "A comment needs no work session (#20), only project access. It records its author and appears in the project's activity.",
  request: {
    params: issueParams,
    body: {
      required: true,
      content: { "application/json": { schema: CreateIssueCommentRequest } },
    },
  },
  responses: {
    201: {
      description: "The comment, written",
      content: { "application/json": { schema: IssueComment } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listActivity = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/activity",
  summary: "A project's activity",
  description:
    "Project creation, issue creation, edits, comments, closes, reopens, and knowledge creation and edits, in the order they happened, each with the human who caused it.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's activity",
      content: { "application/json": { schema: ProjectActivityResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listKnowledge = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/knowledge",
  summary: "The basic Markdown knowledge entries in a project",
  description:
    "A title and a Markdown body per entry, with who created and last edited it. This is the basic entry from #26, not the full vault editor (#6).",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's knowledge entries",
      content: { "application/json": { schema: KnowledgeEntriesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const createKnowledge = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/knowledge",
  summary: "Create a basic Markdown knowledge entry",
  description:
    "Stores the title and Markdown body as written, records the creator, and adds a creation event to the project's activity.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "application/json": { schema: CreateKnowledgeEntryRequest } },
    },
  },
  responses: {
    201: {
      description: "The knowledge entry",
      content: { "application/json": { schema: KnowledgeEntry } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const getKnowledge = createRoute({
  method: "get",
  path: "/api/knowledge/{entryId}",
  summary: "One knowledge entry the caller can access",
  description: "The entry's title, Markdown body, and authorship.",
  request: { params: knowledgeParams },
  responses: {
    200: {
      description: "The knowledge entry",
      content: { "application/json": { schema: KnowledgeEntry } },
    },
    400: problem("The entry id is invalid"),
    401: problem("Not signed in"),
    404: problem("No knowledge entry with this id is accessible to the caller"),
  },
});

const updateKnowledge = createRoute({
  method: "patch",
  path: "/api/knowledge/{entryId}",
  summary: "Edit a basic Markdown knowledge entry",
  description:
    "Every field is optional. A real change records the editor and adds an edit event; a no-op returns the entry unchanged.",
  request: {
    params: knowledgeParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateKnowledgeEntryRequest } },
    },
  },
  responses: {
    200: {
      description: "The knowledge entry after the change",
      content: { "application/json": { schema: KnowledgeEntry } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    404: problem("No knowledge entry with this id is accessible to the caller"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [
  listProjects,
  createProject,
  getProject,
  listIssues,
  createIssue,
  getIssue,
  updateIssue,
  listComments,
  createComment,
  listActivity,
  listKnowledge,
  createKnowledge,
  getKnowledge,
  updateKnowledge,
];

// Transport details rest.ts owns: every projects error kind's HTTP status.
const statusFor = {
  not_signed_in: 401,
  workspace_not_found: 404,
  project_not_found: 404,
  issue_not_found: 404,
  knowledge_entry_not_found: 404,
} as const satisfies Record<ProjectsErrorKind, number>;

function isKind<K extends readonly ProjectsErrorKind[]>(
  error: ProjectsError,
  kinds: K,
): error is ProjectsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const workspaceKinds = ["not_signed_in", "workspace_not_found"] as const;
const projectKinds = ["not_signed_in", "project_not_found"] as const;
const issueKinds = ["not_signed_in", "issue_not_found"] as const;
const knowledgeKinds = ["not_signed_in", "knowledge_entry_not_found"] as const;

// Thin: resolve the session, call the service, map the result to HTTP. The service
// decides who may do what; every error is a Problem built through platform/problem.ts.
function failure<K extends readonly ProjectsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof ProjectsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export function createProjectsRest(service: ProjectsService, sessionReader: SessionReader) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(listProjects, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.listProjects(await sessionReader(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, workspaceKinds);
    }
  });

  app.openapi(createProject, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(
        await service.createProject(await sessionReader(c), workspaceId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, workspaceKinds);
    }
  });

  app.openapi(getProject, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.getProject(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectKinds);
    }
  });

  app.openapi(listIssues, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listIssues(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectKinds);
    }
  });

  app.openapi(createIssue, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.createIssue(await sessionReader(c), projectId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, projectKinds);
    }
  });

  app.openapi(getIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.getIssue(await sessionReader(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueKinds);
    }
  });

  app.openapi(updateIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.updateIssue(await sessionReader(c), issueId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, issueKinds);
    }
  });

  app.openapi(listComments, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.listComments(await sessionReader(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueKinds);
    }
  });

  app.openapi(createComment, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.createComment(await sessionReader(c), issueId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, issueKinds);
    }
  });

  app.openapi(listActivity, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listActivity(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectKinds);
    }
  });

  app.openapi(listKnowledge, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listKnowledge(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectKinds);
    }
  });

  app.openapi(createKnowledge, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.createKnowledge(await sessionReader(c), projectId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, projectKinds);
    }
  });

  app.openapi(getKnowledge, async (c) => {
    try {
      const { entryId } = c.req.valid("param");
      return c.json(await service.getKnowledge(await sessionReader(c), entryId), 200);
    } catch (error) {
      return failure(c, error, knowledgeKinds);
    }
  });

  app.openapi(updateKnowledge, async (c) => {
    try {
      const { entryId } = c.req.valid("param");
      return c.json(
        await service.updateKnowledge(await sessionReader(c), entryId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, knowledgeKinds);
    }
  });

  return app;
}
