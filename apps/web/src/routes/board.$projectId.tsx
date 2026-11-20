import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ActiveWorkSession, Issue } from "@orrery/contract";
import {
  issueBlockedByQuery,
  issuesQuery,
  PriorityBadge,
  projectQuery,
  readyWorkQuery,
  ResourceLoadError,
} from "../features/projects/index.ts";
import { activeSessionsQuery } from "../features/work-sessions/index.ts";

// #84: a project Kanban board over Orrery's fixed workflow. IssueStatus stays open/closed;
// columns are derived during render from existing state, never from a new database enum:
// closed -> Done, Needs input -> its own column, a live session -> In progress, a reserved
// or prioritised issue -> Todo, the rest -> Backlog. Review is reserved for the handoff
// slice and stays empty until sessions can report it. No effect: every value is derived.
const COLUMNS = ["Backlog", "Todo", "In progress", "Needs input", "Review", "Done"] as const;
type BoardColumn = (typeof COLUMNS)[number];

export const Route = createFileRoute("/board/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(activeSessionsQuery(project.workspaceId)),
    ]);
  },
  component: BoardPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="board" error={error} />,
});

function BoardPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  // Issues and live session badges are polled every 4s (design doc: 3-5s MVP polling).
  const { data: issues } = useSuspenseQuery({ ...issuesQuery(projectId), refetchInterval: 4000 });
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(project.workspaceId));
  const { data: ready } = useSuspenseQuery({ ...readyWorkQuery(projectId), refetchInterval: 4000 });
  const readyIds = new Set(ready.map((issue) => issue.id));

  const grouped = new Map<BoardColumn, Issue[]>(COLUMNS.map((column) => [column, []]));
  for (const issue of issues) {
    const column = columnFor(issue, sessions);
    grouped.get(column)?.push(issue);
  }

  return (
    <main>
      <p>
        <Link to="/projects/$projectId" params={{ projectId }}>
          Back to project
        </Link>
      </p>
      <h1>{project.name} · Board</h1>
      <p data-board-ready-count={ready.length}>
        {ready.length} issue{ready.length === 1 ? "" : "s"} ready to claim
      </p>
      <div data-board style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        {COLUMNS.map((column) => (
          <section
            key={column}
            data-board-column={column}
            style={{ border: "1px solid #ccc", padding: "0.75rem", minWidth: "14rem" }}
          >
            <h2>{column}</h2>
            <ul style={{ listStyle: "none", padding: 0 }}>
              {(grouped.get(column) ?? []).map((issue) => (
                <BoardCard
                  key={issue.id}
                  issue={issue}
                  session={sessions.find((candidate) => candidate.issueId === issue.id)}
                  ready={readyIds.has(issue.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

function columnFor(issue: Issue, sessions: readonly ActiveWorkSession[]): BoardColumn {
  if (issue.status === "closed") return "Done";
  if (issue.needsInput) return "Needs input";
  if (sessions.some((session) => session.issueId === issue.id)) return "In progress";
  if (issue.assignee !== null || issue.priority !== "none") return "Todo";
  return "Backlog";
}

function BoardCard({
  issue,
  session,
  ready,
}: {
  issue: Issue;
  session: ActiveWorkSession | undefined;
  ready: boolean;
}) {
  const { data: blockers } = useQuery({
    ...issueBlockedByQuery(issue.id),
    // A human marks an issue as an assignee hint or a blocker from its own page.
    refetchInterval: 4000,
  });
  const state = issue.needsInput
    ? "needs-input"
    : session === undefined
      ? null
      : session.status === "active" && session.stopRequested
        ? "stopping"
        : session.status;

  return (
    <li
      data-board-issue-id={issue.id}
      data-ready={String(ready)}
      style={{ border: "1px solid #ddd", padding: "0.5rem", marginBottom: "0.5rem" }}
    >
      <Link to="/issues/$issueId" params={{ issueId: issue.id }}>
        #{issue.number} {issue.title}
      </Link>
      <div>
        <PriorityBadge priority={issue.priority} />{" "}
        {issue.assignee === null ? (
          <span data-assignee-type="none">Unassigned</span>
        ) : (
          <span data-assignee-type={issue.assignee.agentId !== undefined ? "agent" : "human"}>
            {issue.assignee.agentId !== undefined ? "Agent" : "Human"} ·{" "}
            {issue.assignee.displayName}
          </span>
        )}
      </div>
      {(blockers ?? []).length > 0 && (
        <span data-blocked-by={(blockers ?? []).map((blocker) => blocker.id).join(",")}>
          {" "}
          blocked by {(blockers ?? []).length}
        </span>
      )}
      {state !== null && <span data-session-state={state}> {state}</span>}
    </li>
  );
}
