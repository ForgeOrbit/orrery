import { useSuspenseQuery } from "@tanstack/react-query";
import type { RunChild, RunDetail, RunModelChange } from "@orrery/contract";
import { workspaceRunsQuery } from "./queries.ts";

// The workspace's runs (issue #34). Every reported value is optional: the UI says
// `unknown` rather than inventing a harness, model, or child identity. A run is an agent
// conversation, not a key or a transport session, so two clients sharing one key appear
// as two distinct runs here and a resumed conversation appears once.

const unknown = (value: string | null | undefined) => value ?? "unknown";

function ModelHistory({ changes }: { changes: readonly RunModelChange[] }) {
  if (changes.length === 0) return <p data-model-history-empty>No model changes reported.</p>;
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
  if (workers.length === 0) return <p data-children-empty>No child workers reported.</p>;
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
      <span data-agent-name>{run.agentName}</span> · harness {unknown(run.harness)}
      {run.harnessVersion !== null && <> {run.harnessVersion}</>} · model {unknown(run.model)} ·{" "}
      {run.status}
      <h4>Model changes</h4>
      <ModelHistory changes={run.modelHistory} />
      <h4>Child workers</h4>
      <Children workers={run.children} />
    </li>
  );
}

export function RunsSection({ workspaceId }: { workspaceId: string }) {
  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));
  return (
    <section data-runs-section>
      <h2>Runs</h2>
      {runs.length === 0 ? (
        <p>No runs reported in this workspace yet.</p>
      ) : (
        <ul>
          {runs.map((run) => (
            <RunItem key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}
