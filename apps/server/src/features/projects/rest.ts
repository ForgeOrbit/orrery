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
  ProjectAccessGrant,
  ProjectAccessGrantsResponse,
  ProjectActivityResponse,
  ProjectsResponse,
  SetProjectAccessRequest,
  UpdateIssueRequest,
  UpdateKnowledgeEntryRequest,
  UpdateProjectRequest,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import type { WorkActor } from "./service.ts";
import { ProjectsError, type ProjectsErrorKind, type ProjectsService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const projectParams = z.object({ projectId: z.string().min(1).max(200) });
const issueParams = z.object({ issueId: z.string().min(1).max(200) });
const knowledgeParams = z.object({ entryId: z.string().min(1).max(200) });
const accessParams = projectParams.extend({ humanId: z.string().min(1).max(200) });

const listProjects = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/projects",
  summary: "The projects the caller can access in a workspace",
  description:
    "A personal workspace's owner sees its projects. A shared workspace's owner sees every project; an ordinary member sees only the projects explicitly granted to them. Membership alone never reveals a project. A workspace outside the caller's access answers exactly like a missing one. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The accessible projects in the workspace",
      content: { "application/json": { schema: ProjectsResponse } },
    },
    400: problem("The workspace id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No workspace with this id is accessible to the caller"),
  },
});

const createProject = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/projects",
  summary: "Create a project in a workspace",
  description:
    "A personal workspace's owner or a shared workspace's owner can always create a project. A shared member needs the Create projects capability; the member who creates a project receives Manage on it. The project belongs to the workspace, its creator is recorded as authorship, and the creation is recorded in the project's activity.",
  request: {
    params: workspaceParams,
    body: { required: true, content: { "application/json": { schema: CreateProjectRequest } } },
  },
  responses: {
    201: {
      description: "The project, created in the workspace",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller does not have Create projects in this workspace"),
    404: problem("No workspace with this id is accessible to the caller"),
  },
});

const updateProject = createRoute({
  method: "patch",
  path: "/api/projects/{projectId}",
  summary: "Configure a project",
  description:
    "Manage access may rename the project. A request that does not change the name returns the project unchanged and records no event.",
  request: {
    params: projectParams,
    body: { required: true, content: { "application/json": { schema: UpdateProjectRequest } } },
  },
  responses: {
    200: {
      description: "The project after the change",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("Read or Contribute access cannot configure the project"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listProjectAccess = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/access",
  summary: "The explicit access grants on a project",
  description:
    "Manage only. Workspace owners have implicit Manage and are not listed; a personal project has no collaborators and answers with an empty list.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's explicit grants",
      content: { "application/json": { schema: ProjectAccessGrantsResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    403: problem("Read or Contribute access cannot manage project access"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const setProjectAccess = createRoute({
  method: "patch",
  path: "/api/projects/{projectId}/access",
  summary: "Grant or change a member's project access",
  description:
    "Manage only. The target must be a current member of the project's shared workspace. The level is one of Read, Contribute, or Manage; a real change records an attributed access event in the same transaction.",
  request: {
    params: projectParams,
    body: { required: true, content: { "application/json": { schema: SetProjectAccessRequest } } },
  },
  responses: {
    200: {
      description: "The grant after the change",
      content: { "application/json": { schema: ProjectAccessGrant } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem(
      "Read or Contribute access cannot manage project access, or the project is personal",
    ),
    404: problem("No accessible project or workspace member"),
    409: problem("Workspace owners already have Manage access to every project"),
  },
});

const removeProjectAccess = createRoute({
  method: "delete",
  path: "/api/projects/{projectId}/access/{humanId}",
  summary: "Revoke a member's project access",
  description:
    "Manage only. Revoking is idempotent: a person with no grant is already in the desired state. A real revocation records an attributed access event.",
  request: { params: accessParams },
  responses: {
    204: { description: "The grant was removed" },
    400: problem("The project or member id is invalid"),
    401: problem("Not signed in"),
    403: problem(
      "Read or Contribute access cannot manage project access, or the project is personal",
    ),
    404: problem("No project with this id is accessible to the caller"),
    409: problem("Workspace owners already have Manage access to every project"),
  },
});

const getProject = createRoute({
  method: "get",
  path: "/api/projects/{projectId}",
  summary: "One project the caller can access",
  description:
    "A project's own view. A project outside the caller's access answers exactly like a missing one, so ids cannot be enumerated. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listIssues = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/issues",
  summary: "The issues in a project",
  description:
    "Every issue in the project, oldest number first, with its author and last editor.A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's issues",
      content: { "application/json": { schema: IssuesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const createIssue = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/issues",
  summary: "Create an issue in a project",
  description:
    "Contribute or Manage. The issue gets the project's next local number, starts open, and records its creator. The creation is recorded in the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
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
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot create an issue"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const getIssue = createRoute({
  method: "get",
  path: "/api/issues/{issueId}",
  summary: "One issue the caller can access",
  description:
    "The issue's title, Markdown body, status, and authorship.A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The issue id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const updateIssue = createRoute({
  method: "patch",
  path: "/api/issues/{issueId}",
  summary: "Edit, close, or reopen an issue",
  description:
    "Contribute or Manage. Every field is optional. A title or body change records an edit; a status change records a close or a reopen. A request that changes nothing returns the issue unchanged and records no event. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
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
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot change the issue"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listComments = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/comments",
  summary: "The comments on an issue",
  description:
    "The issue's comments in the order they were written, each with its author.A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue's comments",
      content: { "application/json": { schema: IssueCommentsResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const createComment = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/comments",
  summary: "Comment on an issue",
  description:
    "Contribute or Manage. A comment needs no work session (#20), only project access. It records its author and appears in the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
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
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot comment"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listActivity = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/activity",
  summary: "A project's activity",
  description:
    "Project creation, issue creation, edits, comments, closes, reopens, and knowledge creation and edits, in the order they happened, each with the human who caused it. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's activity",
      content: { "application/json": { schema: ProjectActivityResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listKnowledge = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/knowledge",
  summary: "The basic Markdown knowledge entries in a project",
  description:
    "A title and a Markdown body per entry, with who created and last edited it. This is the basic entry from #26, not the full vault editor (#6). A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's knowledge entries",
      content: { "application/json": { schema: KnowledgeEntriesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const createKnowledge = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/knowledge",
  summary: "Create a basic Markdown knowledge entry",
  description:
    "Contribute or Manage. Stores the title and Markdown body as written, records the creator, and adds a creation event to the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
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
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot create knowledge"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const getKnowledge = createRoute({
  method: "get",
  path: "/api/knowledge/{entryId}",
  summary: "One knowledge entry the caller can access",
  description:
    "The entry's title, Markdown body, and authorship.A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: knowledgeParams },
  responses: {
    200: {
      description: "The knowledge entry",
      content: { "application/json": { schema: KnowledgeEntry } },
    },
    400: problem("The entry id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No knowledge entry with this id is accessible to the caller"),
  },
});

const updateKnowledge = createRoute({
  method: "patch",
  path: "/api/knowledge/{entryId}",
  summary: "Edit a basic Markdown knowledge entry",
  description:
    "Contribute or Manage. Every field is optional. A real change records the editor and adds an edit event; a no-op returns the entry unchanged. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
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
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot edit knowledge"),
    404: problem("No knowledge entry with this id is accessible to the caller"),
  },
});

// Route definitions, for the generated OpenAPI document.
export const routes = [
  listProjects,
  createProject,
  getProject,
  updateProject,
  listProjectAccess,
  setProjectAccess,
  removeProjectAccess,
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
  project_creation_not_allowed: 403,
  insufficient_project_access: 403,
  member_not_found: 404,
  personal_project_access: 403,
  workspace_owner_access: 409,
} as const satisfies Record<ProjectsErrorKind, number>;

function isKind<K extends readonly ProjectsErrorKind[]>(
  error: ProjectsError,
  kinds: K,
): error is ProjectsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const workspaceListKinds = ["not_signed_in", "workspace_not_found"] as const;
const workspaceCreateKinds = [...workspaceListKinds, "project_creation_not_allowed"] as const;
const projectReadKinds = ["not_signed_in", "project_not_found"] as const;
const projectWriteKinds = [...projectReadKinds, "insufficient_project_access"] as const;
const accessKinds = [
  ...projectWriteKinds,
  "member_not_found",
  "personal_project_access",
  "workspace_owner_access",
] as const;
const issueReadKinds = ["not_signed_in", "issue_not_found"] as const;
const issueWriteKinds = [...issueReadKinds, "insufficient_project_access"] as const;
const knowledgeReadKinds = ["not_signed_in", "knowledge_entry_not_found"] as const;
const knowledgeWriteKinds = [...knowledgeReadKinds, "insufficient_project_access"] as const;

// Thin: resolve the session, call the service, map the result to HTTP. The service
// decides who may do what; every error is a Problem built through platform/problem.ts.
function failure<K extends readonly ProjectsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  // A bearer key that fails to authenticate is always a 401 with the agent's stable
  // code; there is no silent fallback to a human session on a project-work route.
  if (isAgentError(error)) {
    return problemResponse(c, {
      status: 401,
      code: error.kind,
      title: error.message,
    });
  }
  if (error instanceof ProjectsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export function createProjectsRest(
  service: ProjectsService,
  sessionReader: SessionReader,
  agentAuthenticator: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  // One actor path for REST and MCP: a bearer key authenticates as an agent, otherwise
  // a browser session acts as a human. An invalid key throws here and becomes a 401;
  // it never falls back to the cookie. Project administration routes do not use this.
  const workActor = async (c: Context): Promise<WorkActor | null> => {
    const identity = await agentAuthenticator(c.req.raw);
    if (identity !== null) return { kind: "agent", identity };
    const account = await sessionReader(c);
    return account === null ? null : { kind: "human", account };
  };

  app.openapi(listProjects, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.listProjects(await workActor(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, workspaceListKinds);
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
      return failure(c, error, workspaceCreateKinds);
    }
  });

  app.openapi(getProject, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.getProject(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(updateProject, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.updateProject(await sessionReader(c), projectId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, projectWriteKinds);
    }
  });

  app.openapi(listProjectAccess, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listProjectAccess(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectWriteKinds);
    }
  });

  app.openapi(setProjectAccess, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.setProjectAccess(await sessionReader(c), projectId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, accessKinds);
    }
  });

  app.openapi(removeProjectAccess, async (c) => {
    try {
      const { projectId, humanId } = c.req.valid("param");
      await service.removeProjectAccess(await sessionReader(c), projectId, humanId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, accessKinds);
    }
  });

  app.openapi(listIssues, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listIssues(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(createIssue, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.createIssue(await workActor(c), projectId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, projectWriteKinds);
    }
  });

  app.openapi(getIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.getIssue(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueReadKinds);
    }
  });

  app.openapi(updateIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.updateIssue(await workActor(c), issueId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, issueWriteKinds);
    }
  });

  app.openapi(listComments, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.listComments(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueReadKinds);
    }
  });

  app.openapi(createComment, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.createComment(await workActor(c), issueId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, issueWriteKinds);
    }
  });

  app.openapi(listActivity, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listActivity(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(listKnowledge, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listKnowledge(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(createKnowledge, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.createKnowledge(await workActor(c), projectId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, projectWriteKinds);
    }
  });

  app.openapi(getKnowledge, async (c) => {
    try {
      const { entryId } = c.req.valid("param");
      return c.json(await service.getKnowledge(await workActor(c), entryId), 200);
    } catch (error) {
      return failure(c, error, knowledgeReadKinds);
    }
  });

  app.openapi(updateKnowledge, async (c) => {
    try {
      const { entryId } = c.req.valid("param");
      return c.json(
        await service.updateKnowledge(await workActor(c), entryId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, knowledgeWriteKinds);
    }
  });

  return app;
}
