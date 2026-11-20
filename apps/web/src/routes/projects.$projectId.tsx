import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ProjectAccessLevel, type Project, type ProjectActivityType } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  createIssue,
  createKnowledgeEntry,
  issueQuery,
  issuesQuery,
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectAccessQuery,
  projectActivityQuery,
  projectQuery,
  projectsQuery,
  removeProjectAccess,
  ResourceLoadError,
  setProjectAccess,
  TitleBodyForm,
  updateProject,
} from "../features/projects/index.ts";

// One project's view: its issues, its basic Markdown knowledge, and the activity that
// records who did what. The effective level decides which controls exist: Read sees the
// content, Contribute changes work, and Manage configures the project and its access.
// The server enforces every level; this only avoids offering buttons that would fail.
export const Route = createFileRoute("/projects/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(knowledgeEntriesQuery(project.id)),
      context.queryClient.ensureQueryData(projectActivityQuery(project.id)),
      ...(project.accessLevel === "manage" && project.workspaceKind === "shared"
        ? [context.queryClient.ensureQueryData(projectAccessQuery(project.id))]
        : []),
    ]);
  },
  component: ProjectPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="project" error={error} />,
});

const activityLabels: Record<ProjectActivityType, string> = {
  project_created: "created the project",
  project_renamed: "renamed the project",
  issue_created: "opened issue",
  issue_edited: "edited issue",
  issue_commented: "commented on issue",
  issue_closed: "closed issue",
  issue_reopened: "reopened issue",
  knowledge_created: "created knowledge",
  knowledge_edited: "edited knowledge",
};

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: issues } = useSuspenseQuery(issuesQuery(project.id));
  const { data: knowledge } = useSuspenseQuery(knowledgeEntriesQuery(project.id));
  const canContribute = project.accessLevel !== "read";
  const canManage = project.accessLevel === "manage";

  return (
    <main>
      <p>
        <Link to="/workspaces/$workspaceId" params={{ workspaceId: project.workspaceId }}>
          Back to workspace
        </Link>
      </p>
      <h1>{project.name}</h1>
      <p>
        Project · <span data-project-access-level={project.accessLevel}>{project.accessLevel}</span>{" "}
        · created by {project.createdBy.displayName}
      </p>

      {canManage && <ProjectSettings key={project.name} project={project} />}

      <section>
        <h2>Issues</h2>
        {issues.length === 0 ? (
          <p>No issues yet.</p>
        ) : (
          <ul>
            {issues.map((issue) => (
              <li key={issue.id} data-issue-id={issue.id}>
                <Link to="/issues/$issueId" params={{ issueId: issue.id }}>
                  #{issue.number} {issue.title}
                </Link>{" "}
                <span data-issue-status={issue.status}>{issue.status}</span>
              </li>
            ))}
          </ul>
        )}
        {canContribute && <CreateIssueForm projectId={project.id} />}
      </section>

      <section>
        <h2>Knowledge</h2>
        {knowledge.length === 0 ? (
          <p>No knowledge entries yet.</p>
        ) : (
          <ul>
            {knowledge.map((entry) => (
              <li key={entry.id} data-knowledge-id={entry.id}>
                <Link to="/knowledge/$entryId" params={{ entryId: entry.id }}>
                  {entry.title}
                </Link>{" "}
                <span>by {entry.updatedBy.displayName}</span>
              </li>
            ))}
          </ul>
        )}
        {canContribute && <CreateKnowledgeForm projectId={project.id} />}
      </section>

      {canManage && project.workspaceKind === "shared" && <ProjectAccess projectId={project.id} />}

      <Activity projectId={project.id} />
    </main>
  );
}

// Manage's project setting: the name. The form is keyed by the server's name at the call
// site, so a successful save remounts it with the committed value without an effect.
function ProjectSettings({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const updated = await updateProject(project.id, { name });
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(project.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectsQuery(project.workspaceId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>Project settings</h2>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="project-rename">Project name</label>
        <input
          id="project-rename"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={120}
        />
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={saving}>
          Save project
        </button>
      </form>
    </section>
  );
}

// Manage's access grants. Workspace owners are implicit and are not rows here. The grant
// form takes an email because the workspace member directory stays owner-only; the
// server resolves it within this project's workspace and refuses anyone outside it.
function ProjectAccess({ projectId }: { projectId: string }) {
  const { data: grants } = useSuspenseQuery(projectAccessQuery(projectId));
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<ProjectAccessLevel>("read");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: projectAccessQuery(projectId).queryKey });
  }

  async function onGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await setProjectAccess(projectId, { email, level });
      setEmail("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not grant access.");
    } finally {
      setSaving(false);
    }
  }

  async function onRevoke(humanId: string) {
    setSaving(true);
    setError(undefined);
    try {
      await removeProjectAccess(projectId, humanId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke access.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>Project access</h2>
      {grants.length === 0 ? (
        <p>No one else has explicit access yet.</p>
      ) : (
        <ul>
          {grants.map((grant) => (
            <li key={grant.humanId} data-project-access-for={grant.email}>
              {grant.email} <span data-access-level={grant.level}>{grant.level}</span>{" "}
              <span>granted by {grant.grantedBy.email}</span>{" "}
              <button type="button" onClick={() => void onRevoke(grant.humanId)} disabled={saving}>
                Revoke access
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void onGrant(event)}>
        <label htmlFor="access-email">Email</label>
        <input
          id="access-email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="off"
        />
        <label htmlFor="access-level">Access level</label>
        <select
          id="access-level"
          name="level"
          value={level}
          onChange={(event) => {
            const next = ProjectAccessLevel.safeParse(event.target.value);
            if (next.success) setLevel(next.data);
          }}
        >
          <option value="read">Read</option>
          <option value="contribute">Contribute</option>
          <option value="manage">Manage</option>
        </select>
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={saving}>
          Grant access
        </button>
      </form>
    </section>
  );
}

function CreateIssueForm({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (
    <TitleBodyForm
      idPrefix="issue"
      titleLabel="Issue title"
      bodyLabel="Description"
      bodyRows={4}
      submitLabel="Create issue"
      fallbackError="Could not create the issue."
      resetOnSuccess
      onSubmit={async ({ title, body }) => {
        const issue = await createIssue(projectId, { title, body });
        queryClient.setQueryData(issueQuery(issue.id).queryKey, issue);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
          queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
        ]);
        await navigate({ to: "/issues/$issueId", params: { issueId: issue.id } });
      }}
    />
  );
}

function CreateKnowledgeForm({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (
    <TitleBodyForm
      idPrefix="knowledge"
      titleLabel="Knowledge title"
      bodyLabel="Markdown"
      bodyRows={6}
      submitLabel="Create knowledge"
      fallbackError="Could not create the entry."
      resetOnSuccess
      onSubmit={async ({ title, body }) => {
        const entry = await createKnowledgeEntry(projectId, { title, body });
        queryClient.setQueryData(knowledgeEntryQuery(entry.id).queryKey, entry);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: knowledgeEntriesQuery(projectId).queryKey }),
          queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
        ]);
        await navigate({ to: "/knowledge/$entryId", params: { entryId: entry.id } });
      }}
    />
  );
}

function Activity({ projectId }: { projectId: string }) {
  const { data: activity } = useSuspenseQuery(projectActivityQuery(projectId));
  return (
    <section>
      <h2>Activity</h2>
      {activity.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        <ul>
          {activity.map((event) => (
            <li key={event.id} data-activity-type={event.type}>
              {event.actor.displayName} {activityLabels[event.type]} “{event.summary}”{" "}
              <time dateTime={event.createdAt}>{event.createdAt}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
