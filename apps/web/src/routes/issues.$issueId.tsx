import { Button } from "@astryxdesign/core/Button";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { type Issue, type IssueDetail, IssueLinkKind, IssueStatus } from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { agentKeysQuery, workspaceAgentKeysQuery } from "../features/agents/index.ts";
import {
  addBlockedBy,
  addIssueLink,
  type AssigneeCandidate,
  AssigneeControl,
  completedSubtaskCount,
  createIssueComment,
  deleteIssue,
  issueBlockedByQuery,
  issueBlockingQuery,
  issueCommentsQuery,
  IssueLabels,
  IssuePriorityControls,
  issueQuery,
  issuesQuery,
  issueStatusLabels,
  PriorityBadge,
  projectActivityQuery,
  projectLabelsQuery,
  projectQuery,
  projectTrashQuery,
  readyWorkQuery,
  removeBlockedBy,
  removeIssueLink,
  ResourceLoadError,
  Subtasks,
  subtasksOf,
  TitleBodyForm,
  updateIssue,
} from "../features/projects/index.ts";
import {
  activeSessionsQuery,
  SessionInspector,
  SessionStatus,
} from "../features/work-sessions/index.ts";
import { workspaceMembersQuery, workspaceQuery } from "../features/workspaces/index.ts";
import { TextAreaField, TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { Markdown } from "../lib/Markdown.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

// One issue's page: read it, edit its Markdown body, move it across states, and comment.
// The project's effective level decides whether write controls appear; Read sees the
// issue and its comments only. Every action refreshes the activity so history stays in step.
export const Route = createFileRoute("/issues/$issueId")({
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
      context.queryClient.ensureQueryData(projectLabelsQuery(issue.projectId)),
      context.queryClient.ensureQueryData(activeSessionsQuery(project.workspaceId)),
    ]);
  },
  component: IssuePage,
  errorComponent: ({ error }) => <ResourceLoadError resource="issue" error={error} />,
});

const STATUS_OPTIONS: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
];

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function IssuePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
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

  const [editOpen, setEditOpen] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const [warnedCloseTarget, setWarnedCloseTarget] = useState<IssueStatus | null>(null);
  const [trashError, setTrashError] = useState<string>();
  const [trashing, setTrashing] = useState(false);

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
  const { data: projectLabels } = useSuspenseQuery(projectLabelsQuery(issue.projectId));
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(project.workspaceId));
  const canContribute = project.accessLevel !== "read";
  const subtasks = subtasksOf(projectIssues, issue.id);
  const openSubtaskCount = subtasks.length - completedSubtaskCount(subtasks);
  const activeSession = sessions.find(
    (session) => session.issueId === issue.id && session.status === "active",
  );

  const isClosed = issue.status === "done" || issue.status === "cancelled";
  const toggleNextStatus: IssueStatus = isClosed ? "todo" : "done";

  async function applyStatus(next: IssueStatus) {
    setStatusSubmitting(true);
    setStatusError(undefined);
    try {
      const updated = await updateIssue(issue.id, { status: next });
      queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
        old === undefined ? old : { ...old, ...updated },
      );
      setWarnedCloseTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(issue.projectId).queryKey }),
      ]);
      toast({ body: `Moved ${issue.identifier} to ${issueStatusLabels[next]}.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not change the issue.";
      setStatusError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setStatusSubmitting(false);
    }
  }

  function requestStatusChange(next: IssueStatus) {
    if (next === issue.status) return;
    if (
      (next === "done" || next === "cancelled") &&
      openSubtaskCount > 0 &&
      warnedCloseTarget !== next
    ) {
      setWarnedCloseTarget(next);
      return;
    }
    void applyStatus(next);
  }

  async function onDelete() {
    setTrashing(true);
    setTrashError(undefined);
    try {
      await deleteIssue(issue.id);
      queryClient.removeQueries({ queryKey: issueQuery(issue.id).queryKey });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectTrashQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(issue.projectId).queryKey }),
      ]);
      toast({ body: `Moved ${issue.identifier} to trash.` });
      await navigate({ to: "/projects/$projectId", params: { projectId: issue.projectId } });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not move the issue to trash.";
      setTrashError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setTrashing(false);
    }
  }

  async function onCopyLink() {
    const url = `${window.location.origin}/issues/${issue.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ body: `Copied link to ${issue.identifier}.` });
    } catch {
      toast({ body: "Could not copy link to clipboard.", type: "error" });
    }
  }

  return (
    <main className="issue-page">
      <PageHeader
        breadcrumbs={[
          <Link key="project" to="/projects/$projectId" params={{ projectId: issue.projectId }}>
            Back to project
          </Link>,
          <Link key="board" to="/board/$projectId" params={{ projectId: issue.projectId }}>
            Board
          </Link>,
          <Text
            key="identifier"
            type="inherit"
            color="inherit"
            className="issue-key"
            data-issue-identifier={issue.identifier}
          >
            {issue.identifier}
          </Text>,
        ]}
        title={issue.title}
        badge={<span data-issue-status={issue.status}>{issueStatusLabels[issue.status]}</span>}
        subtitle={
          <>
            <PriorityBadge priority={issue.priority} /> · Created by {issue.createdBy.displayName} ·
            Updated by {issue.updatedBy.displayName}
          </>
        }
        actions={
          <>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label="Copy link"
              onClick={() => void onCopyLink()}
            />
            {canContribute && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  label="Edit"
                  onClick={() => setEditOpen(true)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  isDisabled={statusSubmitting}
                  label={toggleNextStatus === "done" ? "Close issue" : "Reopen issue"}
                  onClick={() => requestStatusChange(toggleNextStatus)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  label="Move to Trash"
                  isDisabled={activeSession !== undefined || trashing}
                  data-trash-button
                  onClick={() => void onDelete()}
                />
              </>
            )}
          </>
        }
      />

      {statusError !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {statusError}
        </Text>
      )}
      {trashError !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {trashError}
        </Text>
      )}
      {warnedCloseTarget !== null && openSubtaskCount > 0 && (
        <Stack
          direction="horizontal"
          className="issue-alert-bar"
          role="status"
          data-open-subtask-warning
        >
          <Text type="supporting">
            This issue still has {openSubtaskCount} open{" "}
            {openSubtaskCount === 1 ? "subtask" : "subtasks"}. Close it anyway?
          </Text>
          <Button
            type="button"
            label="Close anyway"
            variant="secondary"
            size="sm"
            isDisabled={statusSubmitting}
            onClick={() => void applyStatus(warnedCloseTarget)}
          />
        </Stack>
      )}
      {canContribute && activeSession !== undefined && (
        <Text
          as="p"
          display="block"
          type="supporting"
          className="issue-muted-note"
          data-trash-blocked
        >
          An active work session holds this issue. End the session before moving it to trash.
        </Text>
      )}

      <Stack className="issue-layout">
        <Stack className="issue-primary">
          <section className="page-section issue-description-card">
            <div className="section-toolbar">
              <Heading level={2} color="inherit">
                Description
              </Heading>
              {canContribute && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  label={issue.body === "" ? "Add description" : "Edit"}
                  onClick={() => setEditOpen(true)}
                />
              )}
            </div>
            {issue.body === "" ? (
              <Text as="p" display="block" type="supporting">
                No description yet.
              </Text>
            ) : (
              <div data-issue-body className="issue-description-body">
                <Markdown issueRefs={projectIssues}>{issue.body}</Markdown>
              </div>
            )}
          </section>

          <Subtasks issue={issue} issues={projectIssues} canContribute={canContribute} />

          <Blockers
            issueId={issue.id}
            projectId={issue.projectId}
            blockedBy={blockedBy}
            blocking={blocking}
            candidates={projectIssues}
            canContribute={canContribute}
          />

          <Section className="page-section" padding={3}>
            <Heading level={2} color="inherit">
              Links
            </Heading>
            {issue.links.length === 0 ? (
              <Text as="p" display="block" type="supporting">
                No links attached.
              </Text>
            ) : (
              <ul className="row-list">
                {issue.links.map((link) => (
                  <li key={link.id} className="row-item" data-link-id={link.id}>
                    <div className="row-item-main">
                      <span className="meta-pill" data-link-kind={link.kind}>
                        {link.kind}
                      </span>
                      <AstryxLink href={link.url} target="_blank" rel="noopener noreferrer">
                        {link.title}
                      </AstryxLink>
                    </div>
                    <div className="row-item-meta">
                      <span>{link.createdBy.displayName}</span>
                      {canContribute && (
                        <LinkRemoveButton
                          issueId={issue.id}
                          projectId={issue.projectId}
                          linkId={link.id}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canContribute && (
              <details className="issue-disclosure">
                <summary>Add link</summary>
                <LinkForm issueId={issue.id} projectId={issue.projectId} />
              </details>
            )}
          </Section>

          <Section className="page-section" padding={3}>
            <Heading level={2} color="inherit">
              Comments ({comments.length})
            </Heading>
            {comments.length === 0 ? (
              <Text as="p" display="block" type="supporting">
                No comments yet.
              </Text>
            ) : (
              <ul className="comment-list">
                {comments.map((comment) => (
                  <li key={comment.id} className="comment-card" data-comment-id={comment.id}>
                    <div className="comment-header">
                      <strong>{comment.author.displayName}</strong>
                      <time dateTime={comment.createdAt}>{formatTimestamp(comment.createdAt)}</time>
                    </div>
                    <div data-comment-body className="comment-body">
                      <Markdown issueRefs={projectIssues}>{comment.body}</Markdown>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {canContribute && (
              <CommentForm issueId={issue.id} projectId={issue.projectId} issues={projectIssues} />
            )}
          </Section>
        </Stack>

        <aside className="issue-inspector">
          <section className="issue-properties-panel" aria-label="Issue properties">
            <Heading level={2} color="inherit" className="issue-properties-heading">
              Properties
            </Heading>

            {canContribute && (
              <div className="issue-prop-group">
                <Selector
                  label="Status"
                  id="issue-status-selector"
                  size="sm"
                  value={issue.status}
                  isDisabled={statusSubmitting}
                  onChange={(value) => requestStatusChange(IssueStatus.parse(value))}
                  options={STATUS_OPTIONS.map((status) => ({
                    value: status,
                    label: issueStatusLabels[status],
                  }))}
                />
              </div>
            )}

            {canContribute && (
              <div className="issue-prop-group">
                <AssigneeControl
                  issue={issue}
                  candidates={candidates}
                  canContribute={canContribute}
                />
              </div>
            )}

            {canContribute && (
              <div className="issue-prop-group">
                <IssuePriorityControls
                  issue={issue}
                  issues={projectIssues}
                  projectId={issue.projectId}
                />
              </div>
            )}

            <div className="issue-prop-group">
              <IssueLabels issue={issue} labels={projectLabels} canContribute={canContribute} />
            </div>
          </section>

          <SessionStatus
            issueId={issue.id}
            projectId={issue.projectId}
            canContribute={canContribute}
          />

          <SessionInspector
            key={`${issue.id}:${inspector ?? false}:${inspectorSession ?? ""}`}
            issueId={issue.id}
            canContribute={canContribute}
            initialOpen={inspector}
            initialSessionId={inspectorSession}
          />
        </aside>
      </Stack>

      {canContribute && (
        <Drawer
          isOpen={editOpen}
          onOpenChange={setEditOpen}
          side="end"
          width="32rem"
          label="Edit issue"
        >
          <Layout
            height="fill"
            header={<DrawerHeader title="Edit issue" onOpenChange={setEditOpen} hasDivider />}
          >
            <LayoutContent>
              <TitleBodyForm
                key={issue.updatedAt}
                idPrefix="edit-issue"
                titleLabel="Title"
                bodyLabel="Body"
                bodyRows={10}
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
                    queryClient.invalidateQueries({
                      queryKey: issuesQuery(issue.projectId).queryKey,
                    }),
                    queryClient.invalidateQueries({
                      queryKey: projectActivityQuery(issue.projectId).queryKey,
                    }),
                  ]);
                  setEditOpen(false);
                  toast({ body: "Issue updated." });
                }}
              />
            </LayoutContent>
          </Layout>
        </Drawer>
      )}
    </main>
  );
}

// Directed blocked_by edges (#86). Open blockers are called out because they keep this
// issue out of ready work; closing one is enough to make it ready again.
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
  const toast = useToast();
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
      toast({ body: "Blocker added." });
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
      toast({ body: "Blocker removed." });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not remove the blocker.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const options = candidates.filter(
    (candidate) =>
      candidate.id !== issueId && !blockedBy.some((blocker) => blocker.id === candidate.id),
  );

  return (
    <Section className="page-section" padding={3}>
      <Heading level={2} color="inherit">
        Dependencies
      </Heading>
      {blockedBy.length === 0 && blocking.length === 0 ? (
        <Text as="p" display="block" type="supporting">
          No dependencies linked.
        </Text>
      ) : (
        <>
          {blockedBy.length > 0 && (
            <>
              <Heading level={3} color="inherit">
                Blocked by
              </Heading>
              <ul className="row-list">
                {blockedBy.map((blocker) => (
                  <li
                    key={blocker.id}
                    className="row-item"
                    data-blocker-id={blocker.id}
                    data-blocker-status={blocker.status}
                  >
                    <div className="row-item-main">
                      <Link
                        to="/issues/$issueId"
                        params={{ issueId: blocker.id }}
                        className="row-item-title"
                      >
                        #{blocker.number} {blocker.title}
                      </Link>
                      <span className="meta-pill">{issueStatusLabels[blocker.status]}</span>
                      {blocker.status !== "done" && blocker.status !== "cancelled" && (
                        <Text type="supporting">still blocking</Text>
                      )}
                    </div>
                    {canContribute && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void onRemove(blocker.id)}
                        isDisabled={submitting}
                        label="Remove"
                        variant="destructive"
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {blocking.length > 0 && (
            <>
              <Heading level={3} color="inherit">
                Blocking
              </Heading>
              <ul className="row-list">
                {blocking.map((dependant) => (
                  <li key={dependant.id} className="row-item" data-dependant-id={dependant.id}>
                    <div className="row-item-main">
                      <Link
                        to="/issues/$issueId"
                        params={{ issueId: dependant.id }}
                        className="row-item-title"
                      >
                        #{dependant.number} {dependant.title}
                      </Link>
                      <span className="meta-pill">{issueStatusLabels[dependant.status]}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {canContribute && (
        <details className="issue-disclosure">
          <summary>Add blocker</summary>
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
              size="sm"
              isDisabled={submitting || selected === ""}
              label="Add blocker"
              variant="primary"
            />
          </form>
        </details>
      )}
    </Section>
  );
}

function findHashMention(text: string): { start: number; query: string } | null {
  const match = /(?:^|[\s(])#([a-zA-Z0-9-]*)$/.exec(text);
  if (match === null) return null;
  const query = match[1] ?? "";
  const hashIndex = text.lastIndexOf("#");
  if (hashIndex < 0) return null;
  return { start: hashIndex, query };
}

function CommentForm({
  issueId,
  projectId,
  issues,
}: {
  issueId: string;
  projectId: string;
  issues: Issue[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const mention = findHashMention(body);
  const showMenu = mention !== null && dismissedAt !== mention.start;
  const matches = showMenu
    ? issues
        .filter((candidate) => {
          const q = mention.query.trim().toLowerCase();
          if (q === "") return true;
          return (
            String(candidate.number).includes(q) ||
            candidate.identifier.toLowerCase().includes(q) ||
            candidate.title.toLowerCase().includes(q)
          );
        })
        .slice(0, 6)
    : [];
  const activeIndex = matches.length === 0 ? 0 : Math.min(selectedIndex, matches.length - 1);

  function insertMention(target: Issue) {
    if (mention === null) return;
    setBody(`${body.slice(0, mention.start)}#${target.number} `);
    setDismissedAt(null);
    setSelectedIndex(0);
  }

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
      setDismissedAt(null);
      toast({ body: "Comment added." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="comment-composer" onSubmit={(event) => void onSubmit(event)}>
      <div
        className="mention-field-wrap"
        onKeyDown={(event) => {
          if (matches.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % matches.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((prev) => (prev - 1 + matches.length) % matches.length);
          } else if (event.key === "Enter" || event.key === "Tab") {
            const chosen = matches[activeIndex];
            if (chosen !== undefined) {
              event.preventDefault();
              insertMention(chosen);
            }
          } else if (event.key === "Escape" && mention !== null) {
            event.preventDefault();
            setDismissedAt(mention.start);
          }
        }}
      >
        <TextAreaField
          label="Comment"
          id="issue-comment"
          htmlName="body"
          placeholder="Write a comment… Type # to reference an issue"
          value={body}
          onChange={(value) => {
            setBody(value);
            setDismissedAt(null);
            setSelectedIndex(0);
          }}
          rows={3}
          required
        />
        {matches.length > 0 && (
          <ul className="mention-popover" role="listbox" aria-label="Reference an issue">
            {matches.map((candidate, index) => (
              <li
                key={candidate.id}
                role="option"
                aria-selected={index === activeIndex}
                className={
                  index === activeIndex ? "mention-option mention-option-active" : "mention-option"
                }
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(candidate);
                }}
              >
                <span className="issue-key">{candidate.identifier}</span>
                <span className="mention-option-title">{candidate.title}</span>
                <span className="meta-pill">{issueStatusLabels[candidate.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button
        type="submit"
        size="sm"
        isDisabled={submitting}
        label="Add comment"
        variant="primary"
      />
    </form>
  );
}

function LinkForm({ issueId, projectId }: { issueId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
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
      toast({ body: "Link added." });
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
      <Button type="submit" size="sm" isDisabled={submitting} label="Add link" variant="primary" />
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
  const toast = useToast();
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
      toast({ body: "Link removed." });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not remove the link.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => void onRemove()}
        isDisabled={submitting}
        label="Remove"
        variant="ghost"
      />
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
    </>
  );
}
