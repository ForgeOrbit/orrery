import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Card } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "../../lib/Link.tsx";
import { useId, useState } from "react";
import { isPendingQuestion, issueQuestionsQuery, QuestionDetails } from "../inbox/index.ts";
import { workspaceRunsQuery } from "../runs/index.ts";
import { sessionActivitiesQuery, sessionsQuery } from "./queries.ts";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const number = new Intl.NumberFormat();
const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

export function SessionInspector({
  issueId,
  canContribute,
  initialOpen = false,
  initialSessionId,
}: {
  issueId: string;
  canContribute: boolean;
  initialOpen?: boolean | undefined;
  initialSessionId?: string | undefined;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(initialOpen);

  return (
    <Card className="session-inspector" data-session-inspector aria-label="Session inspector">
      <Stack className="inspector-heading" direction="horizontal" gap={2} wrap="wrap">
        <Heading level={2} color="inherit">
          Session inspector
        </Heading>
        <Button
          label={open ? "Hide session inspector" : "Show session inspector"}
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        />
      </Stack>
      <section id={panelId} hidden={!open}>
        <SessionInspectorDetails
          issueId={issueId}
          canContribute={canContribute}
          open={open}
          initialSessionId={initialSessionId}
        />
      </section>
    </Card>
  );
}

export function SessionInspectorDetails({
  issueId,
  canContribute,
  open,
  initialSessionId,
}: {
  issueId: string;
  canContribute: boolean;
  open: boolean;
  initialSessionId?: string | undefined;
}) {
  const [pickedId, setPickedId] = useState<string | null>(initialSessionId ?? null);

  const sessions = useQuery({ ...sessionsQuery(issueId, open), enabled: open });
  const list = sessions.data ?? [];
  const selected =
    list.find((session) => session.id === pickedId) ??
    list.find((session) => session.status === "active") ??
    list[0];

  const activities = useQuery({
    ...sessionActivitiesQuery(issueId, selected?.id ?? "", open && selected?.status === "active"),
    enabled: open && selected !== undefined,
  });
  const questions = useQuery({ ...issueQuestionsQuery(issueId), enabled: open });
  const runs = useQuery({
    ...workspaceRunsQuery(selected?.workspaceId ?? ""),
    enabled: open && selected !== undefined,
  });
  const run = runs.data?.find((entry) => entry.id === selected?.runId);
  const pendingQuestion = questions.data?.find(
    (question) => isPendingQuestion(question) && question.runId === selected?.runId,
  );
  const displayStatus =
    selected?.stopRequested && selected.status === "active" ? "stopping" : selected?.status;

  return (
    <Stack className="inspector-content">
      {sessions.isPending && (
        <Text as="p" display="block" type="inherit" color="inherit" role="status">
          Loading work sessions…
        </Text>
      )}
      {sessions.isError && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          Could not load work sessions.
        </Text>
      )}
      {sessions.isSuccess && selected === undefined && (
        <Text as="p" display="block" type="inherit" color="inherit">
          No work sessions recorded for this issue.
        </Text>
      )}
      {selected !== undefined && (
        <>
          <Selector
            label="Work session"
            id={`session-inspector-select-${issueId}`}
            value={selected.id}
            onChange={setPickedId}
            options={list.map((session) => ({
              value: session.id,
              label: `${session.status} · ${dateTime.format(new Date(session.createdAt))}`,
            }))}
          />
          <Stack className="inspector-session-label" direction="horizontal" gap={1} wrap="wrap">
            <strong>{run?.agentName ?? "Agent work session"}</strong>
            <Text type="inherit" color="inherit" data-inspector-session-status={displayStatus}>
              {displayStatus}
            </Text>
          </Stack>
          {selected.progress !== "" && (
            <Text
              as="p"
              display="block"
              type="inherit"
              color="inherit"
              className="session-progress"
            >
              {selected.progress}
            </Text>
          )}
          {pendingQuestion !== undefined && (
            <Card padding={3} className="inspector-question">
              <QuestionDetails question={pendingQuestion} />
              {canContribute && (
                <Link to="/inbox" search={{ issue: issueId }} color="accent" hasUnderline>
                  Answer in Inbox
                </Link>
              )}
            </Card>
          )}
          <dl className="session-facts">
            <dt>Harness</dt>
            <dd>{run?.harness ?? "Unknown"}</dd>
            <dt>Model</dt>
            <dd>{run?.model ?? "Unknown"}</dd>
            <dt>Run</dt>
            <dd>
              <code>{selected.runId}</code>
            </dd>
            <dt>Session</dt>
            <dd>
              <code>{selected.id}</code>
            </dd>
            {selected.inputTokens !== null && (
              <>
                <dt>Input tokens</dt>
                <dd>{number.format(selected.inputTokens)}</dd>
              </>
            )}
            {selected.outputTokens !== null && (
              <>
                <dt>Output tokens</dt>
                <dd>{number.format(selected.outputTokens)}</dd>
              </>
            )}
            {selected.costUsdMicros !== null && (
              <>
                <dt>Reported cost</dt>
                <dd>{currency.format(selected.costUsdMicros / 1_000_000)}</dd>
              </>
            )}
          </dl>
          <Heading level={3} color="inherit">
            Session activity
          </Heading>
          {activities.isPending && (
            <Text as="p" display="block" type="inherit" color="inherit" role="status">
              Loading session activity…
            </Text>
          )}
          {activities.isError && (
            <Text as="p" display="block" type="inherit" color="inherit" role="alert">
              Could not load session activity.
            </Text>
          )}
          <ol data-activity-timeline>
            {activities.data?.length === 0 && <li>No activities recorded yet.</li>}
            {activities.data?.map((activity) => (
              <li
                key={activity.id}
                data-activity-id={activity.id}
                data-activity-kind={activity.kind}
              >
                <time dateTime={activity.createdAt}>
                  {dateTime.format(new Date(activity.createdAt))}
                </time>
                <strong>{activity.kind}</strong>
                <Stack data-activity-summary>{activity.summary}</Stack>
                {activity.detail !== null && (
                  <pre data-activity-detail>{JSON.stringify(activity.detail, null, 2)}</pre>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </Stack>
  );
}
