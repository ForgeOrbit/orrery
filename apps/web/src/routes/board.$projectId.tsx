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
import { Stack } from "@astryxdesign/core/Stack";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { type ActiveWorkSession, type Issue, IssueStatus } from "@orrery/contract";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  CreateIssueForm,
  issueBlockedByQuery,
  issuesQuery,
  issueStatusLabels,
  PriorityBadge,
  projectQuery,
  readyWorkQuery,
  ResourceLoadError,
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
      context.queryClient.ensureQueryData(readyWorkQuery(project.id)),
      context.queryClient.ensureQueryData(activeSessionsQuery(project.workspaceId)),
    ]);
  },
  component: BoardPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="board" error={error} />,
});

type BoardFilter = "all" | "needs-input" | "ready";
type BoardPanel = { kind: "new-issue" } | { kind: "session"; issueId: string; sessionId: string };

function BoardPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const { data: issues } = useSuspenseQuery({ ...issuesQuery(projectId), refetchInterval: 4000 });
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(project.workspaceId));
  const { data: ready } = useSuspenseQuery({ ...readyWorkQuery(projectId), refetchInterval: 4000 });
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [panel, setPanel] = useState<BoardPanel>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [createdIssue, setCreatedIssue] = useState<Issue>();

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
  const visible = issues.filter(
    (issue) =>
      filter === "all" || (filter === "needs-input" ? issue.needsInput : readyIds.has(issue.id)),
  );
  const columns = Object.groupBy(visible, (issue) => issue.status);
  const inspected =
    panel?.kind === "session" ? issues.find((issue) => issue.id === panel.issueId) : undefined;

  function showPanel(next: BoardPanel) {
    setPanel(next);
    setPanelOpen(true);
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
            {project.key}-{createdIssue.number}
          </Link>
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
          {IssueStatus.options.map((status) => {
            const lane = columns[status] ?? [];
            return (
              <section
                key={status}
                data-board-column={issueStatusLabels[status]}
                className="board-column"
              >
                <Heading level={2} color="inherit">
                  {issueStatusLabels[status]} <Badge label={lane.length} />
                </Heading>
                <ul>
                  {lane.map((issue) => (
                    <BoardCard
                      key={issue.id}
                      issue={issue}
                      projectKey={project.key}
                      session={sessionsByIssue.get(issue.id)}
                      ready={readyIds.has(issue.id)}
                      onInspect={(sessionId) =>
                        showPanel({ kind: "session", issueId: issue.id, sessionId })
                      }
                    />
                  ))}
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
  projectKey,
  session,
  ready,
  onInspect,
}: {
  issue: Issue;
  projectKey: string;
  session: ActiveWorkSession | undefined;
  ready: boolean;
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
    <li data-board-issue-id={issue.id} data-ready={String(ready)} data-assignee-type={assigneeType}>
      <Card
        className="board-card"
        data-needs-input={issue.needsInput ? "true" : "false"}
        padding={3}
      >
        <Link className="board-card-title" to="/issues/$issueId" params={{ issueId: issue.id }}>
          <Text type="inherit" color="inherit" className="board-card-heading">
            <Text type="inherit" color="inherit" className="issue-key">
              {projectKey}-{issue.number}
            </Text>
            {issue.title}
          </Text>
        </Link>
        {(issue.priority !== "none" ||
          assignee !== null ||
          state !== undefined ||
          blockers.length > 0) && (
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
          </Stack>
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
