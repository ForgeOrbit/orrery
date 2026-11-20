import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type Issue, type IssueDetail, IssueLinkKind } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  addIssueLink,
  createIssueComment,
  issueCommentsQuery,
  issueQuery,
  issuesQuery,
  projectActivityQuery,
  projectQuery,
  removeIssueLink,
  ResourceLoadError,
  TitleBodyForm,
  updateIssue,
} from "../features/projects/index.ts";

// One issue's page: read it, edit its Markdown body, close or reopen it, and comment.
// The project's effective level decides whether those controls appear; Read sees the
// issue and its comments only. Every action refreshes the activity so history stays in step.
export const Route = createFileRoute("/issues/$issueId")({
  loader: async ({ context, params }) => {
    const issue = await context.queryClient.ensureQueryData(issueQuery(params.issueId));
    await Promise.all([
      context.queryClient.ensureQueryData(issueCommentsQuery(params.issueId)),
      context.queryClient.ensureQueryData(projectQuery(issue.projectId)),
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
      {issue.body === "" ? (
        <p>No description.</p>
      ) : (
        <div data-issue-body style={{ whiteSpace: "pre-wrap" }}>
          {issue.body}
        </div>
      )}
      {canContribute && (
        <>
          <IssueStatusButton issue={issue} />
          <EditIssueForm key={issue.updatedAt} issue={issue} />
        </>
      )}

      <section>
        <h2>Links</h2>
        {issue.links.length === 0 ? (
          <p>No links attached.</p>
        ) : (
          <ul>
            {issue.links.map((link) => (
              <li key={link.id} data-link-id={link.id}>
                <span data-link-kind={link.kind}>{link.kind}</span>{" "}
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.title}
                </a>{" "}
                — added by {link.createdBy.displayName}
                {canContribute && (
                  <LinkRemoveButton
                    issueId={issue.id}
                    projectId={issue.projectId}
                    linkId={link.id}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {canContribute && <LinkForm issueId={issue.id} projectId={issue.projectId} />}
      </section>

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
      // The detail also carries links, which this response does not touch: merge into it.
      queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
        old === undefined ? old : { ...old, ...updated },
      );
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
          queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
            old === undefined ? old : { ...old, ...updated },
          );
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

// Links are part of the issue detail, so a change refreshes that query and the activity
// feed rather than a separate links cache.
function LinkForm({ issueId, projectId }: { issueId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<IssueLinkKind>("link");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await addIssueLink(issueId, { url, title, kind });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      setUrl("");
      setTitle("");
      setKind("link");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <label htmlFor="issue-link-url">URL</label>
      <input
        id="issue-link-url"
        name="url"
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://…"
        required
      />
      <label htmlFor="issue-link-title">Title</label>
      <input
        id="issue-link-title"
        name="title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        required
      />
      <label htmlFor="issue-link-kind">Kind</label>
      <select
        id="issue-link-kind"
        name="kind"
        value={kind}
        onChange={(event) => setKind(IssueLinkKind.parse(event.target.value))}
      >
        <option value="pr">PR</option>
        <option value="commit">Commit</option>
        <option value="doc">Doc</option>
        <option value="link">Link</option>
      </select>
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        Add link
      </button>
    </form>
  );
}

function LinkRemoveButton({
  issueId,
  projectId,
  linkId,
}: {
  issueId: string;
  projectId: string;
  linkId: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onRemove() {
    setSubmitting(true);
    setError(undefined);
    try {
      await removeIssueLink(issueId, linkId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => void onRemove()} disabled={submitting}>
        Remove
      </button>
      {error !== undefined && <span role="alert">{error}</span>}
    </>
  );
}
