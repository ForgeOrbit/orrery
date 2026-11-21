import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { type ActiveWorkSession, type Issue, IssuePriority, IssueStatus } from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  completedSubtaskCount,
  CreateIssueForm,
  issueBlockedByQuery,
  issuesQuery,
  issueStatusLabels,
  LabelPill,
  PriorityBadge,
  projectActivityQuery,
  projectLabelsQuery,
  projectQuery,
  readyWorkQuery,
  ResourceLoadError,
  subtasksOf,
  updateIssue,
} from "../features/projects/index.ts";
import { workspaceQuery } from "../features/workspaces/index.ts";
import { activeSessionsQuery, SessionInspectorDetails } from "../features/work-sessions/index.ts";
import { Link } from "../lib/Link.tsx";

export const Route = createFileRoute("/board/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(workspaceQuery(project.workspaceId)),
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(projectLabelsQuery(project.id)),
      context.queryClient.ensureQueryData(readyWorkQuery(project.id)),
      context.queryClient.ensureQueryData(activeSessionsQuery(project.workspaceId)),
    ]);
  },
  component: BoardPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="board" error={error} />,
});

type BoardFilter = "all" | "needs-input" | "ready";
type AssigneeFilter = "all" | "unassigned" | "human" | "agent";
type BoardPanel = { kind: "new-issue" } | { kind: "session"; issueId: string; sessionId: string };

// The workflow order is part of the product contract (#94); never derive it from a
// project's issues or from an unordered object.
const BOARD_COLUMNS: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
];

function BoardPage() {
  const queryClient = useQueryClient();
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const { data: issues } = useSuspenseQuery({ ...issuesQuery(projectId), refetchInterval: 4000 });
  const { data: labels } = useSuspenseQuery(projectLabelsQuery(projectId));
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(project.workspaceId));
  const { data: ready } = useSuspenseQuery({ ...readyWorkQuery(projectId), refetchInterval: 4000 });
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority | "all">("all");
  const [labelFilter, setLabelFilter] = useState("all");
  const [panel, setPanel] = useState<BoardPanel>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [createdIssue, setCreatedIssue] = useState<Issue>();
  const [moveError, setMoveError] = useState<string>();
  const [moving, setMoving] = useState(false);

  const canContribute = project.accessLevel !== "read";
  const readyIds = new Set(ready.map((issue) => issue.id));
  const sessionsByIssue = new Map(
    sessions
      .filter((session) => session.projectId === project.id)
      .map((session) => [session.issueId, session]),
  );
  const needsInputCount = issues.filter((issue) => issue.needsInput).length;
  const filters: { id: BoardFilter; label: string; count: number }[] = [
    { id: "all", label: "All issues", count: issues.length },
    { id: "needs-input", label: "Needs input", count: needsInputCount },
    { id: "ready", label: "Ready to claim", count: readyIds.size },
  ];
  const visible = issues.filter((issue) => {
    if (filter === "needs-input" && !issue.needsInput) return false;
    if (filter === "ready" && !readyIds.has(issue.id)) return false;
    if (assigneeFilter === "unassigned" && issue.assignee !== null) return false;
    if (
      assigneeFilter === "human" &&
      (issue.assignee === null || issue.assignee.agentId !== undefined)
    ) {
      return false;
    }
    if (assigneeFilter === "agent" && issue.assignee?.agentId === undefined) return false;
    if (priorityFilter !== "all" && issue.priority !== priorityFilter) return false;
    if (labelFilter !== "all" && !issue.labels.some((label) => label.id === labelFilter)) {
      return false;
    }
    return true;
  });
  const columns = Object.groupBy(visible, (issue) => issue.status);
  const inspected =
    panel?.kind === "session" ? issues.find((issue) => issue.id === panel.issueId) : undefined;

  function showPanel(next: BoardPanel) {
    setPanel(next);
    setPanelOpen(true);
  }

  async function onMove(issue: Issue, status: IssueStatus) {
    if (status === issue.status) return;
    setMoving(true);
    setMoveError(undefined);
    try {
      await updateIssue(issue.id, { status });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : "Could not move the issue.");
    } finally {
      setMoving(false);
    }
  }

  return (
    <main className="board-page">
      <header className="board-header">
        <nav className="board-breadcrumbs" aria-label="Project location">
          <Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }}>
            {workspace.name}
          </Link>
          <Icon icon="chevronRight" size="xsm" />
          <Link to="/projects/$projectId" params={{ projectId }}>
            {project.name}
          </Link>
        </nav>
        <Stack direction="horizontal" className="board-heading">
          <Heading level={1} color="inherit">
            Board
          </Heading>
          {canContribute && (
            <Button
              label="New issue"
              variant="primary"
              onClick={() => showPanel({ kind: "new-issue" })}
            />
          )}
        </Stack>
        <Stack direction="horizontal" className="board-toolbar">
          <Stack
            direction="horizontal"
            className="board-filters"
            role="group"
            aria-label="Filter issues"
          >
            {filters.map(({ id, label, count }) => (
              <ToggleButton
                key={id}
                label={`${label} (${count})`}
                isPressed={filter === id}
                size="sm"
                className="board-filter"
                data-board-filter={id}
                data-board-ready-count={id === "ready" ? count : undefined}
                onPressedChange={(pressed) => setFilter(pressed ? id : "all")}
              >
                {label} <Badge label={count} />
              </ToggleButton>
            ))}
          </Stack>
          <Stack
            direction="horizontal"
            className="board-filters"
            role="group"
            aria-label="Narrow issues"
          >
            <Selector
              label="Assignee"
              id="board-assignee-filter"
              variant="secondary"
              size="sm"
              value={assigneeFilter}
              onChange={(value) =>
                setAssigneeFilter(
                  value === "unassigned" || value === "human" || value === "agent" ? value : "all",
                )
              }
              options={[
                { value: "all", label: "Any assignee" },
                { value: "unassigned", label: "Unassigned" },
                { value: "human", label: "Human" },
                { value: "agent", label: "Agent" },
              ]}
            />
            <Selector
              label="Priority"
              id="board-priority-filter"
              variant="secondary"
              size="sm"
              value={priorityFilter}
              onChange={(value) =>
                setPriorityFilter(value === "all" ? "all" : IssuePriority.parse(value))
              }
              options={[
                { value: "all", label: "Any priority" },
                ...IssuePriority.options.map((priority) => ({
                  value: priority,
                  label: priority === "none" ? "None" : priority,
                })),
              ]}
            />
            <Selector
              label="Label"
              id="board-label-filter"
              variant="secondary"
              size="sm"
              value={labelFilter}
              onChange={setLabelFilter}
              options={[
                { value: "all", label: "Any label" },
                ...labels.map((label) => ({ value: label.id, label: label.name })),
              ]}
            />
          </Stack>
          {sessionsByIssue.size > 0 && (
            <Text
              as="p"
              display="block"
              type="inherit"
              color="inherit"
              className="board-live"
              data-active-sessions
            >
              {sessionsByIssue.size} active {sessionsByIssue.size === 1 ? "session" : "sessions"}
            </Text>
          )}
        </Stack>
      </header>

      {createdIssue !== undefined && (
        <Text
          as="p"
          display="block"
          type="inherit"
          color="inherit"
          className="board-created"
          role="status"
        >
          Created{" "}
          <Link to="/issues/$issueId" params={{ issueId: createdIssue.id }}>
            {createdIssue.identifier}
          </Link>
        </Text>
      )}

      {moveError !== undefined && (
        <Text as="p" display="block" type="supporting" role="alert" data-board-move-error>
          {moveError}
        </Text>
      )}

      {visible.length === 0 ? (
        <Stack className="board-empty-state">
          <EmptyState
            title={issues.length === 0 ? "No issues yet" : "No matching issues"}
            icon={<Icon icon="viewColumns" size="lg" />}
            headingLevel={2}
            actions={
              filter !== "all" ? (
                <Button label="Show all issues" onClick={() => setFilter("all")} />
              ) : undefined
            }
          />
        </Stack>
      ) : (
        <Stack
          data-board
          direction="horizontal"
          tabIndex={0}
          role="region"
          aria-label="Issue board"
        >
          {BOARD_COLUMNS.map((status) => {
            const lane = columns[status] ?? [];
            return (
              <section
                key={status}
                data-board-column={issueStatusLabels[status]}
                data-board-status={status}
                className="board-column"
              >
                <Heading level={2} color="inherit">
                  {issueStatusLabels[status]} <Badge label={lane.length} />
                </Heading>
                <ul>
                  {lane.map((issue) => {
                    const subtasks = subtasksOf(issues, issue.id);
                    return (
                      <BoardCard
                        key={issue.id}
                        issue={issue}
                        session={sessionsByIssue.get(issue.id)}
                        ready={readyIds.has(issue.id)}
                        subtaskCount={subtasks.length}
                        completedSubtaskCount={completedSubtaskCount(subtasks)}
                        canMove={canContribute && !moving}
                        onMove={(next) => void onMove(issue, next)}
                        onInspect={(sessionId) =>
                          showPanel({ kind: "session", issueId: issue.id, sessionId })
                        }
                      />
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </Stack>
      )}

      <Drawer
        isOpen={panelOpen}
        onOpenChange={setPanelOpen}
        purpose={panel?.kind === "new-issue" ? "form" : "info"}
        label={panel?.kind === "new-issue" ? "New issue" : "Session preview"}
        width="29rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title={
                panel?.kind === "new-issue" ? "New issue" : (inspected?.title ?? "Session preview")
              }
              subtitle={
                inspected === undefined ? project.name : `${project.key}-${inspected.number}`
              }
              onOpenChange={setPanelOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
            {panel?.kind === "new-issue" && canContribute && (
              <CreateIssueForm
                key={project.id}
                projectId={project.id}
                onCreated={(issue) => {
                  setCreatedIssue(issue);
                  setFilter("all");
                  setPanelOpen(false);
                }}
              />
            )}
            {panel?.kind === "session" && (
              <>
                {inspected === undefined ? (
                  <Text as="p" display="block" type="inherit" color="inherit" role="alert">
                    This issue is no longer available.
                  </Text>
                ) : (
                  <>
                    <Link
                      to="/issues/$issueId"
                      params={{ issueId: panel.issueId }}
                      search={{ inspector: true, session: panel.sessionId }}
                    >
                      Open issue
                    </Link>
                    <SessionInspectorDetails
                      key={panel.sessionId}
                      issueId={panel.issueId}
                      canContribute={canContribute}
                      open={panelOpen}
                      initialSessionId={panel.sessionId}
                    />
                  </>
                )}
              </>
            )}
          </LayoutContent>
        </Layout>
      </Drawer>
    </main>
  );
}

function BoardCard({
  issue,
  session,
  ready,
  subtaskCount,
  completedSubtaskCount: doneCount,
  canMove,
  onMove,
  onInspect,
}: {
  issue: Issue;
  session: ActiveWorkSession | undefined;
  ready: boolean;
  subtaskCount: number;
  completedSubtaskCount: number;
  canMove: boolean;
  onMove: (status: IssueStatus) => void;
  onInspect: (sessionId: string) => void;
}) {
  const { data: blockers = [] } = useQuery({
    ...issueBlockedByQuery(issue.id),
    refetchInterval: 4000,
  });
  const state = issue.needsInput
    ? "needs-input"
    : session?.status === "active" && session.stopRequested
      ? "stopping"
      : session?.status;
  const assignee = issue.assignee;
  const assigneeType =
    assignee === null ? "none" : assignee.agentId !== undefined ? "agent" : "human";

  return (
    <li
      data-board-issue-id={issue.id}
      data-ready={String(ready)}
      data-assignee-type={assigneeType}
      data-priority={issue.priority}
    >
      <Card
        className="board-card"
        data-needs-input={issue.needsInput ? "true" : "false"}
        data-subtask-count={subtaskCount}
        data-completed-subtask-count={doneCount}
        padding={3}
      >
        <Link className="board-card-title" to="/issues/$issueId" params={{ issueId: issue.id }}>
          <Text type="inherit" color="inherit" className="board-card-heading">
            <Text
              type="inherit"
              color="inherit"
              className="issue-key"
              data-issue-identifier={issue.identifier}
            >
              {issue.identifier}
            </Text>
            {issue.title}
          </Text>
        </Link>
        {(issue.priority !== "none" ||
          assignee !== null ||
          state !== undefined ||
          blockers.length > 0 ||
          subtaskCount > 0) && (
          <Stack direction="horizontal" className="board-card-meta">
            {issue.priority !== "none" && <PriorityBadge priority={issue.priority} />}
            {state !== undefined && (
              <Text type="inherit" color="inherit" data-session-state={state}>
                {state === "needs-input" ? "Needs input" : state}
              </Text>
            )}
            {blockers.length > 0 && (
              <Text
                type="inherit"
                color="inherit"
                data-blocked-by={blockers.map((blocker) => blocker.id).join(",")}
              >
                Blocked by {blockers.length}
              </Text>
            )}
            {assignee !== null && (
              <Text type="inherit" color="inherit" className="board-assignee">
                <Avatar
                  name={assignee.displayName}
                  shape={assigneeType === "agent" ? "rounded" : "circle"}
                  size="xsm"
                  tooltip={false}
                />
                <Text type="inherit" color="inherit">
                  {assignee.displayName}
                </Text>
              </Text>
            )}
            {subtaskCount > 0 && (
              <Text type="inherit" color="inherit" className="board-card-subtasks">
                Subtasks {doneCount}/{subtaskCount}
              </Text>
            )}
          </Stack>
        )}
        {issue.labels.length > 0 && (
          <Stack direction="horizontal" className="board-card-labels">
            {issue.labels.map((label) => (
              <LabelPill key={label.id} label={label} />
            ))}
          </Stack>
        )}
        {canMove && (
          <Selector
            label={`Move ${issue.identifier}`}
            id={`board-move-${issue.id}`}
            isLabelHidden
            variant="ghost"
            size="sm"
            value={issue.status}
            onChange={(value) => onMove(IssueStatus.parse(value))}
            options={BOARD_COLUMNS.map((status) => ({
              value: status,
              label: issueStatusLabels[status],
            }))}
          />
        )}
        {(issue.needsInput || session !== undefined) && (
          <Stack direction="horizontal" className="board-card-actions">
            {issue.needsInput && (
              <Link
                className="board-card-action"
                to="/inbox"
                search={{ issue: issue.id }}
                color="accent"
                hasUnderline
              >
                View question
              </Link>
            )}
            {session !== undefined && (
              <Button
                className="board-card-action"
                label="Inspect session"
                variant="ghost"
                size="sm"
                onClick={() => onInspect(session.id)}
              />
            )}
          </Stack>
        )}
      </Card>
    </li>
  );
}
