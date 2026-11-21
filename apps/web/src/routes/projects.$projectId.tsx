import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { TextField } from "../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import { ProjectAccessLevel, type Project, type ProjectActivityType } from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  CreateIssueForm,
  createKnowledgeEntry,
  IssuePriorityControls,
  issuesQuery,
  issueStatusLabels,
  knowledgeEntriesQuery,
  knowledgeEntryQuery,
  LabelPill,
  projectAccessQuery,
  projectActivityQuery,
  projectLabelsQuery,
  projectQuery,
  projectsQuery,
  PriorityBadge,
  ProjectLabels,
  removeProjectAccess,
  ResourceLoadError,
  setProjectAccess,
  TitleBodyForm,
  updateProject,
} from "../features/projects/index.ts";

// One project's view: its issues, its basic Markdown knowledge, and the activity that
// records who did what. The effective level decides which controls exist: Read sees the
// content, Contribute changes work, and Manage configures the project and its access.
// The server enforces every level; this only avoids offering buttons that would fail.
export const Route = createFileRoute("/projects/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(projectLabelsQuery(project.id)),
      context.queryClient.ensureQueryData(knowledgeEntriesQuery(project.id)),
      context.queryClient.ensureQueryData(projectActivityQuery(project.id)),
      ...(project.accessLevel === "manage" && project.workspaceKind === "shared"
        ? [context.queryClient.ensureQueryData(projectAccessQuery(project.id))]
        : []),
    ]);
  },
  component: ProjectPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="project" error={error} />,
});

const activityLabels: Record<ProjectActivityType, string> = {
  project_created: "created the project",
  project_renamed: "renamed the project",
  project_fallback_policy_changed: "changed the project fallback policy",
  issue_created: "opened issue",
  issue_edited: "edited issue",
  issue_commented: "commented on issue",
  issue_review_handoff: "handed issue off for review",
  issue_closed: "closed issue",
  issue_reopened: "reopened issue",
  issue_dependency_added: "added a blocker to issue",
  issue_dependency_removed: "removed a blocker from issue",
  issue_link_added: "linked on issue",
  issue_link_removed: "unlinked from issue",
  issue_question_asked: "asked for input on issue",
  issue_question_answered: "answered a question on issue",
  issue_question_paused: "paused a question on issue",
  issue_question_fallback_used: "used an authorized fallback on issue",
  issue_question_follow_up: "added a follow-up to an authorized fallback on issue",
  issue_fallback_policy_override_changed: "changed the fallback policy override on issue",
  issue_stop_requested: "asked the agent to stop on issue",
  project_label_created: "created a project label",
  project_label_edited: "edited a project label",
  project_label_deleted: "deleted a project label",
  issue_label_added: "labelled issue",
  issue_label_removed: "unlabelled issue",
  issue_parent_changed: "changed the parent of issue",
  issue_deleted: "moved issue to trash",
  issue_restored: "restored issue from trash",
  knowledge_created: "created knowledge",
  knowledge_edited: "edited knowledge",
};

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: issues } = useSuspenseQuery(issuesQuery(project.id));
  const { data: labels } = useSuspenseQuery(projectLabelsQuery(project.id));
  const { data: knowledge } = useSuspenseQuery(knowledgeEntriesQuery(project.id));
  const canContribute = project.accessLevel !== "read";
  const canManage = project.accessLevel === "manage";

  return (
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/workspaces/$workspaceId" params={{ workspaceId: project.workspaceId }}>
          Back to workspace
        </Link>{" "}
        ·{" "}
        <Link to="/history/project/$projectId" params={{ projectId: project.id }}>
          View history
        </Link>{" "}
        ·{" "}
        <Link to="/board/$projectId" params={{ projectId: project.id }} data-board-link>
          Board
        </Link>
        {canManage && (
          <>
            {" · "}
            <Link to="/trash/$projectId" params={{ projectId: project.id }} data-trash-link>
              Trash
            </Link>
          </>
        )}
      </Text>
      <Heading level={1} color="inherit">
        {project.name}
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        Project ·{" "}
        <Text type="inherit" color="inherit" data-project-access-level={project.accessLevel}>
          {project.accessLevel}
        </Text>{" "}
        · created by {project.createdBy.displayName}
      </Text>

      {canManage && <ProjectSettings key={project.name} project={project} />}

      <Section className="page-section" padding={0}>
        <Heading level={2} color="inherit">
          Issues
        </Heading>
        {issues.length === 0 ? (
          <Text as="p" display="block" type="inherit" color="inherit">
            No issues yet.
          </Text>
        ) : (
          <ul>
            {issues.map((issue) => (
              <li key={issue.id} data-issue-id={issue.id}>
                <Link to="/issues/$issueId" params={{ issueId: issue.id }}>
                  <Text as="span" className="issue-key" data-issue-identifier={issue.identifier}>
                    {issue.identifier}
                  </Text>{" "}
                  {issue.title}
                </Link>{" "}
                <PriorityBadge priority={issue.priority} />{" "}
                <Text type="inherit" color="inherit" data-issue-status={issue.status}>
                  {issueStatusLabels[issue.status]}
                </Text>{" "}
                {issue.labels.map((label) => (
                  <LabelPill key={label.id} label={label} />
                ))}{" "}
                {canContribute && (
                  <IssuePriorityControls issue={issue} issues={issues} projectId={project.id} />
                )}
              </li>
            ))}
          </ul>
        )}
        {canContribute && <CreateIssueForm projectId={project.id} />}
      </Section>

      <ProjectLabels projectId={project.id} labels={labels} canContribute={canContribute} />

      <Section className="page-section" padding={0}>
        <Heading level={2} color="inherit">
          Knowledge
        </Heading>
        {knowledge.length === 0 ? (
          <Text as="p" display="block" type="inherit" color="inherit">
            No knowledge entries yet.
          </Text>
        ) : (
          <ul>
            {knowledge.map((entry) => (
              <li key={entry.id} data-knowledge-id={entry.id}>
                <Link to="/knowledge/$entryId" params={{ entryId: entry.id }}>
                  {entry.title}
                </Link>{" "}
                <Text type="inherit" color="inherit">
                  by {entry.updatedBy.displayName}
                </Text>
              </li>
            ))}
          </ul>
        )}
        {canContribute && <CreateKnowledgeForm projectId={project.id} />}
      </Section>

      {canManage && project.workspaceKind === "shared" && <ProjectAccess projectId={project.id} />}

      <Activity projectId={project.id} />
    </main>
  );
}

// Manage's project setting: the name. The form is keyed by the server's name at the call
// site, so a successful save remounts it with the committed value without an effect.
function ProjectSettings({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const updated = await updateProject(project.id, { name });
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(project.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectsQuery(project.workspaceId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Project settings
      </Heading>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Project name"
          id="project-rename"
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
        <Button type="submit" isDisabled={saving} label="Save project" variant="primary" />
      </form>
    </Section>
  );
}

// Manage's access grants. Workspace owners are implicit and are not rows here. The grant
// form takes an email because the workspace member directory stays owner-only; the
// server resolves it within this project's workspace and refuses anyone outside it.
function ProjectAccess({ projectId }: { projectId: string }) {
  const { data: grants } = useSuspenseQuery(projectAccessQuery(projectId));
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<ProjectAccessLevel>("read");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: projectAccessQuery(projectId).queryKey });
  }

  async function onGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await setProjectAccess(projectId, { email, level });
      setEmail("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not grant access.");
    } finally {
      setSaving(false);
    }
  }

  async function onRevoke(humanId: string) {
    setSaving(true);
    setError(undefined);
    try {
      await removeProjectAccess(projectId, humanId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke access.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Project access
      </Heading>
      {grants.length === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          No one else has explicit access yet.
        </Text>
      ) : (
        <ul>
          {grants.map((grant) => (
            <li key={grant.humanId} data-project-access-for={grant.email}>
              {grant.email}{" "}
              <Text type="inherit" color="inherit" data-access-level={grant.level}>
                {grant.level}
              </Text>{" "}
              <Text type="inherit" color="inherit">
                granted by {grant.grantedBy.email}
              </Text>{" "}
              <Button
                type="button"
                onClick={() => void onRevoke(grant.humanId)}
                isDisabled={saving}
                label="Revoke access"
                variant="destructive"
              />
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => void onGrant(event)}>
        <TextField
          label="Email"
          id="access-email"
          htmlName="email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="off"
        />

        <Selector
          label="Access level"
          id="access-level"
          htmlName="level"
          value={level}
          onChange={(value) => {
            const next = ProjectAccessLevel.safeParse(value);
            if (next.success) setLevel(next.data);
          }}
          options={[
            { value: "read", label: "Read" },
            { value: "contribute", label: "Contribute" },
            { value: "manage", label: "Manage" },
          ]}
        />
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        <Button type="submit" isDisabled={saving} label="Grant access" variant="primary" />
      </form>
    </Section>
  );
}

function CreateKnowledgeForm({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return (
    <TitleBodyForm
      idPrefix="knowledge"
      titleLabel="Knowledge title"
      bodyLabel="Markdown"
      bodyRows={6}
      submitLabel="Create knowledge"
      fallbackError="Could not create the entry."
      resetOnSuccess
      onSubmit={async ({ title, body }) => {
        const entry = await createKnowledgeEntry(projectId, { title, body });
        queryClient.setQueryData(knowledgeEntryQuery(entry.id).queryKey, entry);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: knowledgeEntriesQuery(projectId).queryKey }),
          queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
        ]);
        await navigate({ to: "/knowledge/$entryId", params: { entryId: entry.id } });
      }}
    />
  );
}

function Activity({ projectId }: { projectId: string }) {
  const { data: activity } = useSuspenseQuery(projectActivityQuery(projectId));
  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Activity
      </Heading>
      {activity.length === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit">
          No activity yet.
        </Text>
      ) : (
        <ul>
          {activity.map((event) => (
            <li key={event.id} data-activity-type={event.type}>
              {event.actor.displayName} {activityLabels[event.type]} “{event.summary}”{" "}
              <time dateTime={event.createdAt}>{event.createdAt}</time>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
