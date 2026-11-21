import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Card } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { ActivityDetailBlockV1, type SessionActivityDetail } from "@orrery/contract";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState, type ReactNode } from "react";
import { TelemetryFacts } from "../../lib/telemetry.tsx";
import { Link } from "../../lib/Link.tsx";
import { isPendingQuestion, issueQuestionsQuery, QuestionDetails } from "../inbox/index.ts";
import { workspaceRunsQuery } from "../runs/index.ts";
import { sessionActivitiesQuery, sessionsQuery } from "./queries.ts";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

// #96: the four v1 structured activity blocks have a closed discriminated union in the
// contract. A renderer registry keeps each shape's presentation in one place; anything
// unversioned or unrecognized falls back to a collapsible, inert JSON viewer below.
type BlockType = ActivityDetailBlockV1["type"];
type BlockRenderer = (block: ActivityDetailBlockV1) => ReactNode;

// Every renderer takes the whole union and narrows on `type`. That keeps the registry
// indexable by a runtime discriminator without an unsafe function-widening assertion.
// Telemetry arrays can repeat values, so keys intentionally include the array position;
// the detail is an immutable snapshot that is never reordered or filtered.
/* eslint-disable react/no-array-index-key -- position disambiguates repeated telemetry values */
const blockRenderers: Record<BlockType, BlockRenderer> = {
  key_value: (block) =>
    block.type === "key_value" ? (
      <dl className="activity-key-value" data-activity-block-kind="key_value">
        {block.items.map((item, index) => (
          <Fragment key={`${item.key}-${index}`}>
            <dt>{item.key}</dt>
            <dd>{item.value}</dd>
          </Fragment>
        ))}
      </dl>
    ) : null,
  table: (block) =>
    block.type === "table" ? (
      <Table className="activity-table" data-activity-block-kind="table">
        <TableHeader>
          <TableRow>
            {block.columns.map((column, index) => (
              <TableHeaderCell key={`${column}-${index}`}>{column}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row, rowIndex) => (
            <TableRow key={`${row.join("|")}-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <TableCell key={`${cell}-${cellIndex}`}>{cell}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    ) : null,
  checklist: (block) =>
    block.type === "checklist" ? (
      <ul className="activity-checklist" data-activity-block-kind="checklist">
        {block.items.map((item, index) => (
          <li key={`${item.label}-${index}`} data-checked={String(item.checked)}>
            <Text type="inherit" color="inherit">
              {item.checked ? "✓" : "○"} {item.label}
            </Text>
          </li>
        ))}
      </ul>
    ) : null,
  test_results: (block) =>
    block.type === "test_results" ? (
      <Stack gap={1} className="activity-test-results" data-activity-block-kind="test_results">
        <Stack direction="horizontal" gap={1} wrap="wrap">
          <Badge variant="success" label={`${block.passed} passed`} />
          <Badge
            variant={block.failed > 0 ? "error" : "neutral"}
            label={`${block.failed} failed`}
          />
          {block.skipped !== undefined && (
            <Badge variant="neutral" label={`${block.skipped} skipped`} />
          )}
        </Stack>
        {block.cases !== undefined && block.cases.length > 0 && (
          <ul>
            {block.cases.map((testCase, index) => (
              <li key={`${testCase.name}-${index}`} data-test-status={testCase.status}>
                <Text type="inherit" color="inherit">
                  {testCase.name} — {testCase.status}
                </Text>
                {testCase.message !== undefined && (
                  <Text type="supporting" color="secondary">
                    {testCase.message}
                  </Text>
                )}
              </li>
            ))}
          </ul>
        )}
      </Stack>
    ) : null,
};
/* eslint-enable react/no-array-index-key */

function JsonFallback({ detail }: { detail: unknown }) {
  return (
    <Stack data-activity-block="json" className="activity-json">
      <Collapsible
        defaultIsOpen={false}
        trigger={
          <Text type="body" weight="semibold">
            Raw activity detail (JSON)
          </Text>
        }
      >
        <pre data-activity-detail>{JSON.stringify(detail, null, 2)}</pre>
      </Collapsible>
    </Stack>
  );
}

function renderDetail(detail: SessionActivityDetail | null): ReactNode {
  // The contract owns the v1 shape. safeParse keeps a malformed or unversioned block
  // from reaching a renderer that assumes a valid shape; those fall back to inert JSON.
  const parsed = ActivityDetailBlockV1.safeParse(detail?.block);
  if (parsed.success) {
    const block = parsed.data;
    return (
      <Stack data-activity-block={block.type} className="activity-block">
        {blockRenderers[block.type](block)}
      </Stack>
    );
  }
  return <JsonFallback detail={detail} />;
}

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
    <Card
      className="session-inspector"
      padding={4}
      data-session-inspector
      aria-label="Session inspector"
    >
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
            <TelemetryFacts
              inputTokens={selected.inputTokens}
              outputTokens={selected.outputTokens}
              costUsdMicros={selected.costUsdMicros}
            />
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
                {activity.detail !== null && renderDetail(activity.detail)}
              </li>
            ))}
          </ol>
        </>
      )}
    </Stack>
  );
}
