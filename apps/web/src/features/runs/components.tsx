import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { RunChild, RunDetail, RunModelChange } from "@orrery/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { workspaceRunsQuery } from "./queries.ts";

// The workspace's runs (issue #34). Every reported value is optional: the UI says
// `unknown` rather than inventing a harness, model, or child identity. A run is an agent
// conversation, not a key or a transport session, so two clients sharing one key appear
// as two distinct runs here and a resumed conversation appears once.

const unknown = (value: string | null | undefined) => value ?? "unknown";

function ModelHistory({ changes }: { changes: readonly RunModelChange[] }) {
  if (changes.length === 0)
    return (
      <Text as="p" display="block" type="inherit" color="inherit" data-model-history-empty>
        No model changes reported.
      </Text>
    );
  return (
    <ul data-model-history>
      {changes.map((change) => (
        <li key={change.id} data-model-change>
          {unknown(change.fromModel)} → {unknown(change.toModel)} · {change.reportedAt}
        </li>
      ))}
    </ul>
  );
}

function Children({ workers }: { workers: readonly RunChild[] }) {
  if (workers.length === 0)
    return (
      <Text as="p" display="block" type="inherit" color="inherit" data-children-empty>
        No child workers reported.
      </Text>
    );
  return (
    <ul data-children>
      {workers.map((child) => (
        <li
          key={child.id}
          data-child-id={child.id}
          data-child-agent-id={unknown(child.agentId)}
          data-child-status={child.status}
        >
          Child {unknown(child.agentId)} ({unknown(child.agentType)}) · model {unknown(child.model)}
          {child.childRunId !== null && <> · run {child.childRunId}</>} · {child.status}
        </li>
      ))}
    </ul>
  );
}

function RunItem({ run }: { run: RunDetail }) {
  return (
    <li data-run-id={run.id} data-harness={unknown(run.harness)} data-model={unknown(run.model)}>
      <strong data-run-label>Run {run.id}</strong> · agent{" "}
      <Text type="inherit" color="inherit" data-agent-name>
        {run.agentName}
      </Text>{" "}
      · harness {unknown(run.harness)}
      {run.harnessVersion !== null && <> {run.harnessVersion}</>} · model {unknown(run.model)} ·{" "}
      {run.status}
      <Heading level={4} color="inherit">
        Model changes
      </Heading>
      <ModelHistory changes={run.modelHistory} />
      <Heading level={4} color="inherit">
        Child workers
      </Heading>
      <Children workers={run.children} />
    </li>
  );
}

export function RunsSection({ workspaceId }: { workspaceId: string }) {
  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));
  if (runs.length === 0) {
    return (
      <Stack className="empty-panel" data-runs-section>
        <EmptyState
          title="No runs reported yet"
          description="Agent conversations connected over MCP or local hooks will appear here."
          headingLevel={2}
        />
      </Stack>
    );
  }
  return (
    <Section className="page-section" padding={0} data-runs-section>
      <Heading level={2} color="inherit">
        Runs
      </Heading>
      <ul className="row-list">
        {runs.map((run) => (
          <RunItem key={run.id} run={run} />
        ))}
      </ul>
    </Section>
  );
}
