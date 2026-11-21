import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Button } from "@astryxdesign/core/Button";
import { TextField } from "../../lib/fields.tsx";
import { Selector } from "@astryxdesign/core/Selector";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "../../lib/Link.tsx";
import {
  AgentKeyValidity,
  ProjectAccessLevel,
  type Agent,
  type AgentKey,
  type Project,
  type RunDetail,
} from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { projectsQuery } from "../projects/index.ts";
import { workspaceRunsQuery } from "../runs/index.ts";
import { activeSessionsQuery, SessionStatus } from "../work-sessions/index.ts";
import {
  createAgent,
  issueAgentKey,
  ownerRevokeAgentKey,
  revokeAgentKey,
  rotateAgentKey,
} from "./commands.ts";
import { agentKeysQuery, agentsQuery, workspaceAgentKeysQuery } from "./queries.ts";

// Agents and their keys (issue #30). An agent is registered under the signed-in human,
// then a key binds it to this workspace and selected projects. The level offered in the
// form is capped by the human's current level on each project; the server rechecks that
// ceiling at issue and on every authenticated request. A key's secret is shown once;
// rotating a key mints an overlapping replacement and shows only the new secret once.
// Every list, including the owner's view of other humans' keys, is secret-free.

const validityOptions = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days (default)" },
  { value: "never", label: "Never" },
] as const;

// The enum's own order is the level order; no second ranking table is needed in the UI.
const levelRank = (level: ProjectAccessLevel) => ProjectAccessLevel.options.indexOf(level);
const levelsUpTo = (cap: ProjectAccessLevel) =>
  ProjectAccessLevel.options.filter((level) => levelRank(level) <= levelRank(cap));

export function AgentsSection({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const { data: agents } = useSuspenseQuery(agentsQuery);
  const { data: mine } = useSuspenseQuery(agentKeysQuery(workspaceId));
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  // Run metadata is joined on the client by run id: it supplies harness/model/subagent
  // attribution without a cross-feature SQL join.
  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));
  // An owner also sees keys issued by other humans in this workspace. The query is
  // disabled for ordinary members, whose view stays their own keys.
  const workspaceKeys = useQuery({ ...workspaceAgentKeysQuery(workspaceId), enabled: isOwner });
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();

  const ownIds = new Set(mine.map((key) => key.id));
  const allKeys = new Map<string, AgentKey>();
  for (const key of mine) allKeys.set(key.id, key);
  for (const key of workspaceKeys.data ?? []) allKeys.set(key.id, key);

  async function rotate(key: AgentKey) {
    setBusyKey(key.id);
    setError(undefined);
    try {
      // Omitted options preserve the source's validity and grants; the server re-caps
      // those grants by the human's current access and returns a fresh one-time secret.
      const replacement = await rotateAgentKey(key.id);
      setSecret(replacement.secret);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rotate the key.");
    } finally {
      setBusyKey(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeysQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceAgentKeysQuery(workspaceId).queryKey }),
      ]);
    }
  }

  async function revoke(key: AgentKey, owner: boolean) {
    setBusyKey(key.id);
    setError(undefined);
    try {
      if (owner) await ownerRevokeAgentKey(workspaceId, key.id);
      else await revokeAgentKey(key.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the key.");
    } finally {
      setBusyKey(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeysQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceAgentKeysQuery(workspaceId).queryKey }),
      ]);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Agents
      </Heading>
      {secret !== undefined && (
        <Stack role="status" data-agent-secret>
          <Text as="p" display="block" type="inherit" color="inherit">
            Copy this key now. It is shown once and cannot be recovered later.
          </Text>
          <code>{secret}</code>{" "}
          <Button
            type="button"
            onClick={() => setSecret(undefined)}
            label="Dismiss"
            variant="secondary"
          />
        </Stack>
      )}
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Heading level={3} color="inherit">
        Registered agents
      </Heading>
      {agents.length === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          No agents yet. Register one below to issue a key.
        </Text>
      ) : (
        <ul>
          {agents.map((agent) => (
            <li key={agent.id} data-agent-id={agent.id}>
              {agent.name}
            </li>
          ))}
        </ul>
      )}
      <Heading level={3} color="inherit">
        Active work sessions
      </Heading>
      <ActiveSessions workspaceId={workspaceId} projects={projects} runs={runs} />
      <RegisterAgentForm />
      {agents.length > 0 && (
        <IssueKeyForm
          agents={agents}
          projects={projects}
          workspaceId={workspaceId}
          onIssued={setSecret}
        />
      )}
      <Heading level={3} color="inherit">
        Keys in this workspace
      </Heading>
      {allKeys.size === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          No keys scoped to this workspace.
        </Text>
      ) : (
        <ul>
          {[...allKeys.values()].map((key) => (
            <li
              key={key.id}
              data-agent-key-id={key.id}
              data-revoked={String(key.revokedAt !== null)}
            >
              {key.agentName} · {key.validity} ·{" "}
              {key.projects.map((grant) => grant.projectName).join(", ") || "no projects"}
              {key.revokedAt !== null && (
                <Text type="inherit" color="inherit" data-key-status>
                  {" "}
                  · revoked
                </Text>
              )}
              {key.revokedAt !== null ? (
                <Button type="button" isDisabled label="Revoked" variant="secondary" />
              ) : ownIds.has(key.id) ? (
                <>
                  <Button
                    type="button"
                    isDisabled={busyKey === key.id}
                    onClick={() => void rotate(key)}
                    label="Rotate"
                    variant="secondary"
                  />{" "}
                  <Button
                    type="button"
                    isDisabled={busyKey === key.id}
                    onClick={() => void revoke(key, false)}
                    label="Revoke"
                    variant="destructive"
                  />
                </>
              ) : (
                isOwner && (
                  <Button
                    type="button"
                    isDisabled={busyKey === key.id}
                    onClick={() => void revoke(key, true)}
                    label="Revoke (owner)"
                    variant="destructive"
                  />
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// #82: the agents view lists only live sessions from the workspace-level read, rather
// than polling every issue of every project. The same badge and one-click stop control
// as the issue page lets a human stop an agent without revoking its key.
function ActiveSessions({
  workspaceId,
  projects,
  runs,
}: {
  workspaceId: string;
  projects: readonly Project[];
  runs: readonly RunDetail[];
}) {
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(workspaceId));
  if (sessions.length === 0)
    return (
      <Text as="p" display="block" type="inherit" color="inherit">
        No active work sessions.
      </Text>
    );
  const levels = new Map(projects.map((project) => [project.id, project.accessLevel]));
  const runById = new Map(runs.map((run) => [run.id, run]));
  return (
    <ul>
      {sessions.map((session) => {
        const run = runById.get(session.runId);
        const canContribute = levels.get(session.projectId) !== "read";
        return (
          <li
            key={session.id}
            data-agent-session-id={session.id}
            data-issue-id={session.issueId}
            {...(run?.harness ? { "data-session-harness": run.harness } : {})}
          >
            <Link to="/issues/$issueId" params={{ issueId: session.issueId }}>
              Issue {session.issueId}
            </Link>{" "}
            <Text type="inherit" color="inherit">
              harness: {run?.harness ?? "unknown"}
            </Text>{" "}
            <Text type="inherit" color="inherit" data-session-model={run?.model ?? "unknown"}>
              model: {run?.model ?? "unknown"}
            </Text>{" "}
            <Text type="inherit" color="inherit" data-subagent-count={run?.children.length ?? 0}>
              subagents: {run?.children.length ?? 0}
            </Text>{" "}
            <Text type="inherit" color="inherit" data-run-heartbeat={run?.lastHeartbeatAt ?? ""}>
              last run heartbeat: {run?.lastHeartbeatAt ?? "unknown"}
            </Text>{" "}
            <Text type="inherit" color="inherit" data-lease-expires-at={session.leaseExpiresAt}>
              lease until {session.leaseExpiresAt}
            </Text>{" "}
            <Text type="inherit" color="inherit" data-last-heartbeat={session.updatedAt}>
              last check-in {session.updatedAt}
            </Text>{" "}
            <SessionStatus
              issueId={session.issueId}
              projectId={session.projectId}
              canContribute={canContribute}
            />{" "}
            <Link
              to="/issues/$issueId"
              params={{ issueId: session.issueId }}
              search={{ inspector: true, session: session.id }}
              data-sidecar-link
            >
              Sidecar
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function RegisterAgentForm() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await createAgent(name);
      setName("");
      await queryClient.invalidateQueries({ queryKey: agentsQuery.queryKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not register the agent.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <TextField
        label="Agent name"
        id="agent-name"
        htmlName="name"
        value={name}
        onChange={setName}
        required
        maxLength={120}
      />
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button type="submit" isDisabled={submitting} label="Register agent" variant="primary" />
    </form>
  );
}

function IssueKeyForm({
  agents,
  projects,
  workspaceId,
  onIssued,
}: {
  agents: Agent[];
  projects: readonly { id: string; name: string; accessLevel: ProjectAccessLevel }[];
  workspaceId: string;
  onIssued: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [validity, setValidity] = useState<AgentKeyValidity>("90");
  const [selected, setSelected] = useState<Record<string, ProjectAccessLevel>>({});
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function toggle(projectId: string, checked: boolean) {
    setSelected((current) => {
      const next = { ...current };
      // The lowest level is within every cap, so it is always a safe default.
      if (checked) next[projectId] = "read";
      else delete next[projectId];
      return next;
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const issued = await issueAgentKey({
        agentId,
        workspaceId,
        validity,
        projects: Object.entries(selected).map(([projectId, level]) => ({ projectId, level })),
      });
      onIssued(issued.secret);
      setSelected({});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeysQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceAgentKeysQuery(workspaceId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not issue the key.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Heading level={3} color="inherit">
        Issue a key
      </Heading>

      <Selector
        label="Agent"
        id="key-agent"
        value={agentId}
        onChange={setAgentId}
        options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
      />

      <Selector
        label="Validity"
        id="key-validity"
        value={validity}
        onChange={(value) => setValidity(AgentKeyValidity.parse(value))}
        options={validityOptions.map((option) => ({ value: option.value, label: option.label }))}
      />
      <fieldset>
        <legend>Project access</legend>
        {projects.map((project) => {
          const allowed = levelsUpTo(project.accessLevel);
          const current = selected[project.id] ?? "read";
          return (
            <Stack key={project.id}>
              <CheckboxInput
                label={`${project.name} (your access: ${project.accessLevel})`}
                value={project.id in selected}
                onChange={(checked) => toggle(project.id, checked)}
              />{" "}
              <Selector
                label={`Level for ${project.name}`}
                value={current}
                isDisabled={!(project.id in selected)}
                onChange={(value) =>
                  setSelected((state) => ({
                    ...state,
                    [project.id]: ProjectAccessLevel.parse(value),
                  }))
                }
                options={allowed.map((level) => ({ value: level, label: level }))}
              />
            </Stack>
          );
        })}
      </fieldset>
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
      <Button
        type="submit"
        isDisabled={submitting || agentId === ""}
        label="Issue key"
        variant="primary"
      />
    </form>
  );
}
