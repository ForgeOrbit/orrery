import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ProjectActivityType } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  createIssue,
  createKnowledgeEntry,
  issueQuery,
  issuesQuery,
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  projectActivityQuery,
  projectQuery,
  ResourceLoadError,
} from "../features/projects/index.ts";

// One project's view: its issues, its basic Markdown knowledge, and the activity that
// records who did what. Creating an issue or an entry leads to its own page, where the
// rest of the cycle (edit, comment, close, reopen) happens.
export const Route = createFileRoute("/projects/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(knowledgeEntriesQuery(project.id)),
      context.queryClient.ensureQueryData(projectActivityQuery(project.id)),
    ]);
  },
  component: ProjectPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="project" error={error} />,
});

const activityLabels: Record<ProjectActivityType, string> = {
  project_created: "created the project",
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

  return (
    <main>
      <p>
        <Link to="/workspaces/$workspaceId" params={{ workspaceId: project.workspaceId }}>
          Back to workspace
        </Link>
      </p>
      <h1>{project.name}</h1>
      <p>Project · created by {project.createdBy.email}</p>

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
        <CreateIssueForm projectId={project.id} />
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
                <span>by {entry.updatedBy.email}</span>
              </li>
            ))}
          </ul>
        )}
        <CreateKnowledgeForm projectId={project.id} />
      </section>

      <Activity projectId={project.id} />
    </main>
  );
}

function CreateIssueForm({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const issue = await createIssue(projectId, { title, body });
      queryClient.setQueryData(issueQuery(issue.id).queryKey, issue);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      setTitle("");
      setBody("");
      await navigate({ to: "/issues/$issueId", params: { issueId: issue.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor="issue-title">Issue title</label>
      <input
        id="issue-title"
        name="title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        required
        maxLength={200}
      />
      <label htmlFor="issue-body">Description</label>
      <textarea
        id="issue-body"
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={4}
      />
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Create issue
      </button>
    </form>
  );
}

function CreateKnowledgeForm({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const entry = await createKnowledgeEntry(projectId, { title, body });
      queryClient.setQueryData(knowledgeEntryQuery(entry.id).queryKey, entry);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: knowledgeEntriesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      setTitle("");
      setBody("");
      await navigate({ to: "/knowledge/$entryId", params: { entryId: entry.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the entry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor="knowledge-title">Knowledge title</label>
      <input
        id="knowledge-title"
        name="title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        required
        maxLength={200}
      />
      <label htmlFor="knowledge-body">Markdown</label>
      <textarea
        id="knowledge-body"
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={6}
      />
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Create knowledge
      </button>
    </form>
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
              {event.actor.email} {activityLabels[event.type]} “{event.summary}”{" "}
              <time dateTime={event.createdAt}>{event.createdAt}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
