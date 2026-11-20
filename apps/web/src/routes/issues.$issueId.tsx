import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { Issue } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  addBlockedBy,
  createIssueComment,
  issueBlockedByQuery,
  issueBlockingQuery,
  issueCommentsQuery,
  issueQuery,
  issuesQuery,
  projectActivityQuery,
  projectQuery,
  removeBlockedBy,
  ResourceLoadError,
  TitleBodyForm,
  updateIssue,
} from "../features/projects/index.ts";
import { SessionStatus } from "../features/work-sessions/index.ts";

// One issue's page: read it, edit its Markdown body, close or reopen it, and comment.
// The project's effective level decides whether those controls appear; Read sees the
// issue and its comments only. Every action refreshes the activity so history stays in step.
export const Route = createFileRoute("/issues/$issueId")({
  loader: async ({ context, params }) => {
    const issue = await context.queryClient.ensureQueryData(issueQuery(params.issueId));
    await Promise.all([
      context.queryClient.ensureQueryData(issueCommentsQuery(params.issueId)),
      context.queryClient.ensureQueryData(projectQuery(issue.projectId)),
      context.queryClient.ensureQueryData(issueBlockedByQuery(params.issueId)),
      context.queryClient.ensureQueryData(issueBlockingQuery(params.issueId)),
      context.queryClient.ensureQueryData(issuesQuery(issue.projectId)),
    ]);
  },
  component: IssuePage,
  errorComponent: ({ error }) => <ResourceLoadError resource="issue" error={error} />,
});

function IssuePage() {
  const { issueId } = Route.useParams();
  const { data: issue } = useSuspenseQuery(issueQuery(issueId));
  const { data: comments } = useSuspenseQuery(issueCommentsQuery(issueId));
  const { data: project } = useSuspenseQuery(projectQuery(issue.projectId));
  const { data: blockedBy } = useSuspenseQuery(issueBlockedByQuery(issueId));
  const { data: blocking } = useSuspenseQuery(issueBlockingQuery(issueId));
  const { data: projectIssues } = useSuspenseQuery(issuesQuery(issue.projectId));
  const canContribute = project.accessLevel !== "read";

  return (
    <main>
      <p>
        <Link to="/projects/$projectId" params={{ projectId: issue.projectId }}>
          Back to project
        </Link>
      </p>
      <h1>{issue.title}</h1>
      <p data-issue-status={issue.status}>
        Issue #{issue.number} · {issue.status} · created by {issue.createdBy.displayName} · last
        edited by {issue.updatedBy.displayName}
      </p>
      <SessionStatus issueId={issue.id} projectId={issue.projectId} canContribute={canContribute} />
      {issue.body === "" ? (
        <p>No description.</p>
      ) : (
        <div data-issue-body style={{ whiteSpace: "pre-wrap" }}>
          {issue.body}
        </div>
      )}
      <Blockers
        issueId={issue.id}
        projectId={issue.projectId}
        blockedBy={blockedBy}
        blocking={blocking}
        candidates={projectIssues}
        canContribute={canContribute}
      />

      {canContribute && (
        <>
          <IssueStatusButton issue={issue} />
          <EditIssueForm key={issue.updatedAt} issue={issue} />
        </>
      )}

      <section>
        <h2>Comments</h2>
        {comments.length === 0 ? (
          <p>No comments yet.</p>
        ) : (
          <ul>
            {comments.map((comment) => (
              <li key={comment.id} data-comment-id={comment.id}>
                <p>
                  {comment.author.displayName} ·{" "}
                  <time dateTime={comment.createdAt}>{comment.createdAt}</time>
                </p>
                <div style={{ whiteSpace: "pre-wrap" }}>{comment.body}</div>
              </li>
            ))}
          </ul>
        )}
        {canContribute && <CommentForm issueId={issue.id} projectId={issue.projectId} />}
      </section>
    </main>
  );
}

// Directed blocked_by edges (#86). Open blockers are called out because they keep this
// issue out of ready work; closing one is enough to make it ready again. Only same-project
// issues can be offered, and the server rejects self-links and cycles with a Problem that
// renders here as the form's error.
function Blockers({
  issueId,
  projectId,
  blockedBy,
  blocking,
  candidates,
  canContribute,
}: {
  issueId: string;
  projectId: string;
  blockedBy: Issue[];
  blocking: Issue[];
  candidates: Issue[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: issueBlockedByQuery(issueId).queryKey }),
      queryClient.invalidateQueries({ queryKey: issueBlockingQuery(issueId).queryKey }),
      queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
    ]);

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === "") return;
    setSubmitting(true);
    setError(undefined);
    try {
      await addBlockedBy(issueId, selected);
      setSelected("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the blocker.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(blockedByIssueId: string) {
    setSubmitting(true);
    setError(undefined);
    try {
      await removeBlockedBy(issueId, blockedByIssueId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the blocker.");
    } finally {
      setSubmitting(false);
    }
  }

  const options = candidates.filter(
    (candidate) =>
      candidate.id !== issueId && !blockedBy.some((blocker) => blocker.id === candidate.id),
  );

  return (
    <section>
      <h2>Dependencies</h2>
      <h3>Blocked by</h3>
      {blockedBy.length === 0 ? (
        <p>Nothing blocks this issue.</p>
      ) : (
        <ul>
          {blockedBy.map((blocker) => (
            <li key={blocker.id} data-blocker-id={blocker.id} data-blocker-status={blocker.status}>
              <Link to="/issues/$issueId" params={{ issueId: blocker.id }}>
                #{blocker.number} {blocker.title}
              </Link>{" "}
              · {blocker.status}
              {blocker.status !== "closed" ? " — open, not ready" : ""}
              {canContribute && (
                <button
                  type="button"
                  onClick={() => void onRemove(blocker.id)}
                  disabled={submitting}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>Blocking</h3>
      {blocking.length === 0 ? (
        <p>This issue blocks nothing.</p>
      ) : (
        <ul>
          {blocking.map((dependant) => (
            <li key={dependant.id} data-dependant-id={dependant.id}>
              <Link to="/issues/$issueId" params={{ issueId: dependant.id }}>
                #{dependant.number} {dependant.title}
              </Link>{" "}
              · {dependant.status}
            </li>
          ))}
        </ul>
      )}
      {canContribute && (
        <form onSubmit={(event) => void onAdd(event)}>
          <label htmlFor="issue-blocker">Add a blocker</label>
          <select
            id="issue-blocker"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            required
          >
            <option value="">Choose an issue…</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                #{option.number} {option.title}
              </option>
            ))}
          </select>
          {error !== undefined && <p role="alert">{error}</p>}
          <button type="submit" disabled={submitting || selected === ""}>
            Add blocker
          </button>
        </form>
      )}
    </section>
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

  return (
    <section>
      <h2>Edit issue</h2>
      <TitleBodyForm
        idPrefix="edit-issue"
        titleLabel="Title"
        bodyLabel="Body"
        bodyRows={6}
        submitLabel="Save issue"
        fallbackError="Could not save the issue."
        initialTitle={issue.title}
        initialBody={issue.body}
        onSubmit={async ({ title, body }) => {
          const updated = await updateIssue(issue.id, { title, body });
          queryClient.setQueryData(issueQuery(issue.id).queryKey, updated);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
            queryClient.invalidateQueries({
              queryKey: projectActivityQuery(issue.projectId).queryKey,
            }),
          ]);
        }}
      />
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
