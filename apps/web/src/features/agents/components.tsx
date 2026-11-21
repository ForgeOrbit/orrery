import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { TextField } from "../../lib/fields.tsx";
import { TelemetryInline } from "../../lib/telemetry.tsx";
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

const validityOptions = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days (default)" },
  { value: "never", label: "Never" },
] as const;

const levelRank = (level: ProjectAccessLevel) => ProjectAccessLevel.options.indexOf(level);
const levelsUpTo = (cap: ProjectAccessLevel) =>
  ProjectAccessLevel.options.filter((level) => levelRank(level) <= levelRank(cap));

export function AgentsSection({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const { data: agents } = useSuspenseQuery(agentsQuery);
  const { data: mine } = useSuspenseQuery(agentKeysQuery(workspaceId));
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));

  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));

  const workspaceKeys = useQuery({ ...workspaceAgentKeysQuery(workspaceId), enabled: isOwner });
  const queryClient = useQueryClient();
  const toast = useToast();
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [issueKeyOpen, setIssueKeyOpen] = useState(false);

  async function copySecret(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ body: "API key copied to clipboard." });
    } catch {
      toast({
        body: "Could not access the clipboard. Select and copy the key manually.",
        type: "error",
      });
    }
  }

  const ownIds = new Set(mine.map((key) => key.id));
  const allKeys = new Map<string, AgentKey>();
  for (const key of mine) allKeys.set(key.id, key);
  for (const key of workspaceKeys.data ?? []) allKeys.set(key.id, key);

  async function rotate(key: AgentKey) {
    setBusyKey(key.id);
    setError(undefined);
    try {
      const replacement = await rotateAgentKey(key.id);
      setSecret(replacement.secret);
      setCopied(false);
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
    <Stack className="section-stack">
      {secret !== undefined && (
        <Section className="page-section" padding={3}>
          <Stack role="status" data-agent-secret gap={2}>
            <Text as="p" display="block" type="inherit" color="inherit">
              Copy this key now. It is shown once and cannot be recovered later.
            </Text>
            <Stack direction="horizontal" className="secret-reveal-row">
              <code className="secret-reveal-code">{secret}</code>
              <Stack direction="horizontal" className="page-header-actions">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void copySecret(secret)}
                  label={copied ? "Copied" : "Copy"}
                  variant="primary"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setSecret(undefined);
                    setCopied(false);
                  }}
                  label="Dismiss"
                  variant="secondary"
                />
              </Stack>
            </Stack>
          </Stack>
        </Section>
      )}
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}

      <Section className="page-section" padding={3}>
        <Stack direction="horizontal" className="section-toolbar">
          <Heading level={2} color="inherit">
            Registered agents
          </Heading>
          <Button
            type="button"
            label="Register agent"
            variant="primary"
            size="sm"
            onClick={() => setRegisterOpen(true)}
          />
        </Stack>
        {agents.length === 0 ? (
          <Text as="p" display="block" type="supporting">
            No agents registered yet. Register an agent to issue workspace-scoped API keys.
          </Text>
        ) : (
          <ul className="row-list">
            {agents.map((agent) => (
              <li key={agent.id} data-agent-id={agent.id} className="row-item">
                <Text type="inherit" color="inherit" className="row-item-title">
                  {agent.name}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section className="page-section" padding={3}>
        <Stack direction="horizontal" className="section-toolbar">
          <Heading level={2} color="inherit">
            Active work sessions
          </Heading>
        </Stack>
        <ActiveSessions workspaceId={workspaceId} projects={projects} runs={runs} />
      </Section>

      <Section className="page-section" padding={3}>
        <Stack direction="horizontal" className="section-toolbar">
          <Heading level={2} color="inherit">
            Keys in this workspace
          </Heading>
          {agents.length > 0 && (
            <Button
              type="button"
              label="Issue key"
              variant="secondary"
              size="sm"
              onClick={() => setIssueKeyOpen(true)}
            />
          )}
        </Stack>
        {allKeys.size === 0 ? (
          <Text as="p" display="block" type="supporting">
            No keys scoped to this workspace.
          </Text>
        ) : (
          <ul className="row-list">
            {[...allKeys.values()].map((key) => (
              <li
                key={key.id}
                data-agent-key-id={key.id}
                data-revoked={String(key.revokedAt !== null)}
                className="row-item"
              >
                <Stack direction="horizontal" className="row-item-main">
                  <Text type="inherit" color="inherit" className="row-item-title">
                    {key.agentName}
                  </Text>
                  {key.keyHint !== null ? (
                    <code className="agent-key-hint" data-agent-key-hint>
                      {key.keyHint}
                    </code>
                  ) : (
                    <span
                      className="agent-key-hint"
                      data-agent-key-hint-legacy
                      title="Issued before key previews were stored (only the SHA-256 hash exists). Rotate or issue a new key to show its prefix preview."
                    >
                      legacy · {key.id.slice(0, 8)}
                    </span>
                  )}
                  <span className="meta-pill">{key.validity}</span>
                  <Text type="supporting">
                    {key.projects.map((grant) => grant.projectName).join(", ") || "no projects"}
                  </Text>
                  {key.revokedAt !== null && (
                    <span className="meta-pill" data-key-status>
                      revoked
                    </span>
                  )}
                </Stack>
                <Stack direction="horizontal" className="page-header-actions">
                  {key.revokedAt !== null ? (
                    <Button
                      type="button"
                      size="sm"
                      isDisabled
                      label="Revoked"
                      variant="secondary"
                    />
                  ) : ownIds.has(key.id) ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        isDisabled={busyKey === key.id}
                        onClick={() => void rotate(key)}
                        label="Rotate"
                        variant="secondary"
                      />
                      <Button
                        type="button"
                        size="sm"
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
                        size="sm"
                        isDisabled={busyKey === key.id}
                        onClick={() => void revoke(key, true)}
                        label="Revoke (owner)"
                        variant="destructive"
                      />
                    )
                  )}
                </Stack>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Drawer
        isOpen={registerOpen}
        onOpenChange={setRegisterOpen}
        purpose="form"
        label="Register agent"
        width="26rem"
      >
        <Layout
          height="auto"
          header={<DrawerHeader title="Register agent" onOpenChange={setRegisterOpen} hasDivider />}
        >
          <LayoutContent>
            <RegisterAgentForm onCreated={() => setRegisterOpen(false)} />
          </LayoutContent>
        </Layout>
      </Drawer>

      {agents.length > 0 && (
        <Drawer
          isOpen={issueKeyOpen}
          onOpenChange={setIssueKeyOpen}
          purpose="form"
          label="Issue workspace API key"
          width="28rem"
        >
          <Layout
            height="auto"
            header={
              <DrawerHeader
                title="Issue workspace API key"
                onOpenChange={setIssueKeyOpen}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <IssueKeyForm
                agents={agents}
                projects={projects}
                workspaceId={workspaceId}
                onIssued={(value) => {
                  setSecret(value);
                  setCopied(false);
                  setIssueKeyOpen(false);
                }}
              />
            </LayoutContent>
          </Layout>
        </Drawer>
      )}
    </Stack>
  );
}

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
            <TelemetryInline
              inputTokens={session.inputTokens}
              outputTokens={session.outputTokens}
              costUsdMicros={session.costUsdMicros}
            />{" "}
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

function RegisterAgentForm({ onCreated }: { onCreated?: () => void }) {
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
      onCreated?.();
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
