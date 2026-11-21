import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { Stack } from "@astryxdesign/core/Stack";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextAreaField } from "../lib/fields.tsx";
import { TextField } from "../lib/fields.tsx";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import { type Issue, type IssueDetail, IssueLinkKind } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  addBlockedBy,
  addIssueLink,
  AssigneeControl,
  type AssigneeCandidate,
  createIssueComment,
  issueBlockedByQuery,
  issueBlockingQuery,
  issueCommentsQuery,
  IssuePriorityControls,
  issueQuery,
  issuesQuery,
  issueStatusLabels,
  projectActivityQuery,
  projectQuery,
  PriorityBadge,
  removeBlockedBy,
  removeIssueLink,
  ResourceLoadError,
  TitleBodyForm,
  updateIssue,
} from "../features/projects/index.ts";
import { SessionInspector, SessionStatus } from "../features/work-sessions/index.ts";
import { workspaceMembersQuery, workspaceQuery } from "../features/workspaces/index.ts";
import { agentKeysQuery, workspaceAgentKeysQuery } from "../features/agents/index.ts";

// One issue's page: read it, edit its Markdown body, close or reopen it, and comment.
// The project's effective level decides whether those controls appear; Read sees the
// issue and its comments only. Every action refreshes the activity so history stays in step.
export const Route = createFileRoute("/issues/$issueId")({
  // A sidecar link from the board or agents panel opens the inspector and preselects the
  // session. Plain function validation keeps the search shape typed without an adapter.
  validateSearch: (search: Record<string, unknown>) => {
    const parsed: { inspector?: true; session?: string } = {};
    if (search.inspector === true || search.inspector === "true") parsed.inspector = true;
    if (typeof search.session === "string") parsed.session = search.session;
    return parsed;
  },
  loader: async ({ context, params }) => {
    const issue = await context.queryClient.ensureQueryData(issueQuery(params.issueId));
    const project = await context.queryClient.ensureQueryData(projectQuery(issue.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(issueCommentsQuery(params.issueId)),
      context.queryClient.ensureQueryData(workspaceQuery(project.workspaceId)),
      context.queryClient.ensureQueryData(agentKeysQuery(project.workspaceId)),
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
  const { inspector, session: inspectorSession } = Route.useSearch();
  const { data: issue } = useSuspenseQuery(issueQuery(issueId));
  const { data: comments } = useSuspenseQuery(issueCommentsQuery(issueId));
  const { data: project } = useSuspenseQuery(projectQuery(issue.projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const canReadMembers =
    workspace.kind === "shared" &&
    (workspace.isOwner || workspace.canManageMemberPermissions || workspace.canRemoveMembers);
  const membersQuery = useQuery({
    ...workspaceMembersQuery(project.workspaceId),
    enabled: canReadMembers,
  });
  const { data: myKeys } = useSuspenseQuery(agentKeysQuery(project.workspaceId));
  const workspaceKeys = useQuery({
    ...workspaceAgentKeysQuery(project.workspaceId),
    enabled: workspace.kind === "shared" && workspace.isOwner,
  });
  const candidates: AssigneeCandidate[] = [];
  const seenHumans = new Set<string>();
  for (const actor of [project.createdBy, issue.createdBy, issue.updatedBy]) {
    if (actor.humanId && !seenHumans.has(actor.humanId)) {
      seenHumans.add(actor.humanId);
      candidates.push({
        value: `human:${actor.humanId}`,
        label: `Human · ${actor.email ?? actor.displayName}`,
        assignee: { type: "human" as const, id: actor.humanId },
      });
    }
  }
  for (const member of membersQuery.data ?? []) {
    if (seenHumans.has(member.humanId)) continue;
    seenHumans.add(member.humanId);
    candidates.push({
      value: `human:${member.humanId}`,
      label: `Human · ${member.email}`,
      assignee: { type: "human" as const, id: member.humanId },
    });
  }
  const seen = new Set<string>();
  for (const key of [...myKeys, ...(workspaceKeys.data ?? [])]) {
    if (key.revokedAt !== null || seen.has(key.agentId)) continue;
    seen.add(key.agentId);
    candidates.push({
      value: `agent:${key.agentId}`,
      label: `Agent · ${key.agentName}`,
      assignee: { type: "agent" as const, id: key.agentId },
    });
  }
  const { data: blockedBy } = useSuspenseQuery(issueBlockedByQuery(issueId));
  const { data: blocking } = useSuspenseQuery(issueBlockingQuery(issueId));
  const { data: projectIssues } = useSuspenseQuery(issuesQuery(issue.projectId));
  const canContribute = project.accessLevel !== "read";

  return (
    <main className="issue-page">
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/projects/$projectId" params={{ projectId: issue.projectId }}>
          Back to project
        </Link>
      </Text>
      <Heading level={1} color="inherit">
        {issue.title}
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit" data-issue-status={issue.status}>
        <Text type="inherit" color="inherit" className="issue-key">
          {project.key}-{issue.number}
        </Text>{" "}
        · <PriorityBadge priority={issue.priority} /> · {issueStatusLabels[issue.status]} · created
        by {issue.createdBy.displayName} · last edited by {issue.updatedBy.displayName}
      </Text>
      <Stack className="issue-layout">
        <aside className="issue-inspector">
          <SessionInspector
            key={`${issue.id}:${inspector ?? false}:${inspectorSession ?? ""}`}
            issueId={issue.id}
            canContribute={canContribute}
            initialOpen={inspector}
            initialSessionId={inspectorSession}
          />
        </aside>
        <Stack className="issue-primary">
          {issue.body === "" ? (
            <Text as="p" display="block" type="inherit" color="inherit">
              No description.
            </Text>
          ) : (
            <Stack data-issue-body style={{ whiteSpace: "pre-wrap" }}>
              {issue.body}
            </Stack>
          )}
          <SessionStatus
            issueId={issue.id}
            projectId={issue.projectId}
            canContribute={canContribute}
          />
          {canContribute && (
            <AssigneeControl issue={issue} candidates={candidates} canContribute={canContribute} />
          )}
          {canContribute && (
            <Section className="page-section" padding={0}>
              <Heading level={2} color="inherit">
                Priority and order
              </Heading>
              <IssuePriorityControls
                issue={issue}
                issues={projectIssues}
                projectId={issue.projectId}
              />
            </Section>
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

          <Section className="page-section" padding={0}>
            <Heading level={2} color="inherit">
              Links
            </Heading>
            {issue.links.length === 0 ? (
              <Text as="p" display="block" type="inherit" color="inherit">
                No links attached.
              </Text>
            ) : (
              <ul>
                {issue.links.map((link) => (
                  <li key={link.id} data-link-id={link.id}>
                    <Text type="inherit" color="inherit" data-link-kind={link.kind}>
                      {link.kind}
                    </Text>{" "}
                    <AstryxLink href={link.url} target="_blank" rel="noopener noreferrer">
                      {link.title}
                    </AstryxLink>{" "}
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
          </Section>

          <Section className="page-section" padding={0}>
            <Heading level={2} color="inherit">
              Comments
            </Heading>
            {comments.length === 0 ? (
              <Text as="p" display="block" type="inherit" color="inherit">
                No comments yet.
              </Text>
            ) : (
              <ul>
                {comments.map((comment) => (
                  <li key={comment.id} data-comment-id={comment.id}>
                    <Text as="p" display="block" type="inherit" color="inherit">
                      {comment.author.displayName} ·{" "}
                      <time dateTime={comment.createdAt}>{comment.createdAt}</time>
                    </Text>
                    <Stack style={{ whiteSpace: "pre-wrap" }}>{comment.body}</Stack>
                  </li>
                ))}
              </ul>
            )}
            {canContribute && <CommentForm issueId={issue.id} projectId={issue.projectId} />}
          </Section>
        </Stack>
      </Stack>
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
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Dependencies
      </Heading>
      <Heading level={3} color="inherit">
        Blocked by
      </Heading>
      {blockedBy.length === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          Nothing blocks this issue.
        </Text>
      ) : (
        <ul>
          {blockedBy.map((blocker) => (
            <li key={blocker.id} data-blocker-id={blocker.id} data-blocker-status={blocker.status}>
              <Link to="/issues/$issueId" params={{ issueId: blocker.id }}>
                #{blocker.number} {blocker.title}
              </Link>{" "}
              · {blocker.status}
              {blocker.status === "done" || blocker.status === "cancelled"
                ? ""
                : " — not terminal, still blocking"}
              {canContribute && (
                <Button
                  type="button"
                  onClick={() => void onRemove(blocker.id)}
                  isDisabled={submitting}
                  label="Remove"
                  variant="destructive"
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Heading level={3} color="inherit">
        Blocking
      </Heading>
      {blocking.length === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          This issue blocks nothing.
        </Text>
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
          <Selector
            label="Add a blocker"
            id="issue-blocker"
            value={selected}
            onChange={setSelected}
            options={[
              { value: "", label: "Choose an issue…" },
              ...options.map((option) => ({
                value: option.id,
                label: `#${option.number} ${option.title}`,
              })),
            ]}
          />
          {error !== undefined && (
            <Text as="p" display="block" type="inherit" color="inherit" role="alert">
              {error}
            </Text>
          )}
          <Button
            type="submit"
            isDisabled={submitting || selected === ""}
            label="Add blocker"
            variant="primary"
          />
        </form>
      )}
    </Section>
  );
}

// Closing and reopening are one transition on the issue; the button follows the status
// the server returned, not a local guess. #94's terminal states are done and cancelled;
// every other status is "open work" for this simple control (the full six-state workflow
// is available over REST and MCP).
function IssueStatusButton({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const isClosed = issue.status === "done" || issue.status === "cancelled";
  const next = isClosed ? "todo" : "done";

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
    <Section className="page-section" padding={0}>
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button
        type="button"
        onClick={() => void onToggle()}
        isDisabled={submitting}
        label={next === "done" ? "Close issue" : "Reopen issue"}
        variant="secondary"
      />
    </Section>
  );
}

// Keyed by updatedAt at the call site: a successful save remounts the form with the
// server's values, so no effect is needed to synchronize it.
function EditIssueForm({ issue }: { issue: Issue }) {
  const queryClient = useQueryClient();

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Edit issue
      </Heading>
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
    </Section>
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
      <TextAreaField
        label="Comment"
        id="issue-comment"
        htmlName="body"
        value={body}
        onChange={setBody}
        rows={4}
        required
      />
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button type="submit" isDisabled={submitting} label="Add comment" variant="primary" />
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
    <form className="form-stack" onSubmit={(event) => void onSubmit(event)}>
      <TextField
        label="URL"
        id="issue-link-url"
        htmlName="url"
        type="url"
        value={url}
        onChange={setUrl}
        placeholder="https://…"
        required
      />

      <TextField
        label="Link label"
        id="issue-link-title"
        htmlName="title"
        value={title}
        onChange={setTitle}
        required
      />

      <Selector
        label="Kind"
        id="issue-link-kind"
        htmlName="kind"
        value={kind}
        onChange={(value) => setKind(IssueLinkKind.parse(value))}
        options={[
          { value: "pr", label: "PR" },
          { value: "commit", label: "Commit" },
          { value: "doc", label: "Doc" },
          { value: "link", label: "Link" },
        ]}
      />
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button type="submit" isDisabled={submitting} label="Add link" variant="primary" />
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
      <Button
        type="button"
        onClick={() => void onRemove()}
        isDisabled={submitting}
        label="Remove"
        variant="destructive"
      />
      {error !== undefined && (
        <Text type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
    </>
  );
}
