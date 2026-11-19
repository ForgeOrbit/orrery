import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { Issue } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  createIssueComment,
  issueCommentsQuery,
  issueQuery,
  issuesQuery,
  projectActivityQuery,
  updateIssue,
} from "../features/projects/index.ts";
import { ApiProblemError } from "../lib/api.ts";

// One issue's page: read it, edit its Markdown body, close or reopen it, and comment.
// Every action refreshes the project's activity so the history stays in step.
export const Route = createFileRoute("/issues/$issueId")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(issueQuery(params.issueId));
    await context.queryClient.ensureQueryData(issueCommentsQuery(params.issueId));
  },
  component: IssuePage,
  errorComponent: ({ error }) => <IssueLoadError error={error} />,
});

function IssuePage() {
  const { issueId } = Route.useParams();
  const { data: issue } = useSuspenseQuery(issueQuery(issueId));
  const { data: comments } = useSuspenseQuery(issueCommentsQuery(issueId));

  return (
    <main>
      <p>
        <Link to="/projects/$projectId" params={{ projectId: issue.projectId }}>
          Back to project
        </Link>
      </p>
      <h1>{issue.title}</h1>
      <p data-issue-status={issue.status}>
        Issue #{issue.number} · {issue.status} · created by {issue.createdBy.email} · last edited by{" "}
        {issue.updatedBy.email}
      </p>
      {issue.body === "" ? (
        <p>No description.</p>
      ) : (
        <div data-issue-body style={{ whiteSpace: "pre-wrap" }}>
          {issue.body}
        </div>
      )}
      <IssueStatusButton issue={issue} />
      <EditIssueForm key={issue.updatedAt} issue={issue} />

      <section>
        <h2>Comments</h2>
        {comments.length === 0 ? (
          <p>No comments yet.</p>
        ) : (
          <ul>
            {comments.map((comment) => (
              <li key={comment.id} data-comment-id={comment.id}>
                <p>
                  {comment.author.email} ·{" "}
                  <time dateTime={comment.createdAt}>{comment.createdAt}</time>
                </p>
                <div style={{ whiteSpace: "pre-wrap" }}>{comment.body}</div>
              </li>
            ))}
          </ul>
        )}
        <CommentForm issueId={issue.id} projectId={issue.projectId} />
      </section>
    </main>
  );
}

// Closing and reopening are one transition on the issue; the button follows the status
// the server returned, not a local guess.
function IssueStatusButton({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const next = issue.status === "open" ? "closed" : "open";

  async function onToggle() {
    setSubmitting(true);
    setError(undefined);
    try {
      const updated = await updateIssue(issue.id, { status: next });
      queryClient.setQueryData(issueQuery(issue.id).queryKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(issue.projectId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void onToggle()} disabled={submitting}>
        {next === "closed" ? "Close issue" : "Reopen issue"}
      </button>
    </section>
  );
}

// Keyed by updatedAt at the call site: a successful save remounts the form with the
// server's values, so no effect is needed to synchronize it.
function EditIssueForm({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const updated = await updateIssue(issue.id, { title, body });
      queryClient.setQueryData(issueQuery(issue.id).queryKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(issue.projectId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2>Edit issue</h2>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="edit-issue-title">Title</label>
        <input
          id="edit-issue-title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={200}
        />
        <label htmlFor="edit-issue-body">Body</label>
        <textarea
          id="edit-issue-body"
          name="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={6}
        />
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          Save issue
        </button>
      </form>
    </section>
  );
}

function CommentForm({ issueId, projectId }: { issueId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await createIssueComment(issueId, { body });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueCommentsQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      setBody("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor="issue-comment">Comment</label>
      <textarea
        id="issue-comment"
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={4}
        required
      />
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Add comment
      </button>
    </form>
  );
}

function IssueLoadError({ error }: { error: unknown }) {
  if (error instanceof ApiProblemError && error.status === 401) {
    return (
      <main>
        <h1>Issue</h1>
        <p role="alert">Sign in to view this issue.</p>
        <p>
          <Link to="/signin">Sign in</Link>
        </p>
      </main>
    );
  }
  if (error instanceof ApiProblemError && error.status === 404) {
    return (
      <main>
        <h1>Issue</h1>
        <p role="alert">This issue does not exist or is not available to you.</p>
        <p>
          <Link to="/">Go to your workspaces</Link>
        </p>
      </main>
    );
  }
  return (
    <main>
      <h1>Issue</h1>
      <p role="alert">Could not load this issue. Check your connection and try again.</p>
    </main>
  );
}
