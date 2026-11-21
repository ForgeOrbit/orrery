import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { ProjectAccessLevel, type Project, type ProjectActivityType } from "@orrery/contract";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

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

type ProjectTab = "issues" | "knowledge" | "labels" | "activity" | "settings";

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: issues } = useSuspenseQuery(issuesQuery(project.id));
  const { data: labels } = useSuspenseQuery(projectLabelsQuery(project.id));
  const { data: knowledge } = useSuspenseQuery(knowledgeEntriesQuery(project.id));
  const canContribute = project.accessLevel !== "read";
  const canManage = project.accessLevel === "manage";
  const [tab, setTab] = useState<ProjectTab>("issues");
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newKnowledgeOpen, setNewKnowledgeOpen] = useState(false);
  const activeTab: ProjectTab = tab === "settings" && !canManage ? "issues" : tab;

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          <Link
            key="workspace"
            to="/workspaces/$workspaceId"
            params={{ workspaceId: project.workspaceId }}
          >
            Back to workspace
          </Link>,
        ]}
        title={project.name}
        badge={project.key}
        subtitle={
          <>
            Access:{" "}
            <Text type="inherit" color="inherit" data-project-access-level={project.accessLevel}>
              {project.accessLevel}
            </Text>{" "}
            · created by {project.createdBy.displayName}
          </>
        }
        actions={
          <>
            <Link
              to="/board/$projectId"
              params={{ projectId: project.id }}
              color="inherit"
              data-board-link
            >
              Board
            </Link>
            {canManage && (
              <Link
                to="/trash/$projectId"
                params={{ projectId: project.id }}
                color="inherit"
                data-trash-link
              >
                Trash
              </Link>
            )}
            <Link
              to="/history/project/$projectId"
              params={{ projectId: project.id }}
              color="inherit"
            >
              View history
            </Link>
            {canContribute && (
              <Button
                type="button"
                label="New issue"
                variant="primary"
                size="sm"
                onClick={() => setNewIssueOpen(true)}
              />
            )}
          </>
        }
      />

      <TabList
        value={activeTab}
        onChange={(value) => {
          if (
            value === "issues" ||
            value === "knowledge" ||
            value === "labels" ||
            value === "activity" ||
            value === "settings"
          ) {
            setTab(value);
          }
        }}
        role="tablist"
        aria-label="Project sections"
        size="sm"
        hasDivider
      >
        <Tab
          value="issues"
          label="Issues"
          panelId="panel-issues"
          endContent={<Badge label={issues.length} />}
        />
        <Tab
          value="knowledge"
          label="Knowledge"
          panelId="panel-knowledge"
          endContent={<Badge label={knowledge.length} />}
        />
        <Tab
          value="labels"
          label="Labels"
          panelId="panel-labels"
          endContent={<Badge label={labels.length} />}
        />
        <Tab value="activity" label="Activity" panelId="panel-activity" />
        {canManage && <Tab value="settings" label="Settings" panelId="panel-settings" />}
      </TabList>

      {activeTab === "issues" && (
        <section id="panel-issues" role="tabpanel" className="tab-panel">
          {issues.length === 0 ? (
            <Stack className="empty-panel">
              <EmptyState
                title="No issues yet"
                description="Create your first issue or open the Board to start staging work."
                icon={<Icon icon="viewColumns" size="lg" />}
                headingLevel={2}
                actions={
                  canContribute ? (
                    <Button
                      label="New issue"
                      variant="primary"
                      onClick={() => setNewIssueOpen(true)}
                    />
                  ) : undefined
                }
              />
            </Stack>
          ) : (
            <ul className="row-list">
              {issues.map((issue) => (
                <li key={issue.id} data-issue-id={issue.id} className="row-item">
                  <Stack direction="horizontal" className="row-item-main">
                    <Text as="span" className="issue-key" data-issue-identifier={issue.identifier}>
                      {issue.identifier}
                    </Text>
                    <Link
                      to="/issues/$issueId"
                      params={{ issueId: issue.id }}
                      className="row-item-title"
                    >
                      {issue.title}
                    </Link>
                    {issue.labels.map((label) => (
                      <LabelPill key={label.id} label={label} />
                    ))}
                  </Stack>
                  <Stack direction="horizontal" className="row-item-meta">
                    <PriorityBadge priority={issue.priority} />
                    <span className="meta-pill" data-issue-status={issue.status}>
                      {issueStatusLabels[issue.status]}
                    </span>
                    {canContribute && (
                      <IssuePriorityControls issue={issue} issues={issues} projectId={project.id} />
                    )}
                  </Stack>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === "knowledge" && (
        <section id="panel-knowledge" role="tabpanel" className="tab-panel">
          <Stack direction="horizontal" className="section-toolbar">
            <Heading level={2} color="inherit">
              Knowledge
            </Heading>
            {canContribute && (
              <Button
                type="button"
                label="New document"
                variant="primary"
                size="sm"
                onClick={() => setNewKnowledgeOpen(true)}
              />
            )}
          </Stack>
          {knowledge.length === 0 ? (
            <Stack className="empty-panel">
              <EmptyState
                title="No knowledge entries yet"
                description="Capture architecture notes and decisions for humans and agents."
                headingLevel={3}
                actions={
                  canContribute ? (
                    <Button
                      label="New document"
                      variant="primary"
                      onClick={() => setNewKnowledgeOpen(true)}
                    />
                  ) : undefined
                }
              />
            </Stack>
          ) : (
            <ul className="row-list">
              {knowledge.map((entry) => (
                <li key={entry.id} data-knowledge-id={entry.id} className="row-item">
                  <Link
                    to="/knowledge/$entryId"
                    params={{ entryId: entry.id }}
                    className="row-item-title"
                  >
                    {entry.title}
                  </Link>
                  <Text type="supporting">by {entry.updatedBy.displayName}</Text>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === "labels" && (
        <section id="panel-labels" role="tabpanel" className="tab-panel">
          <ProjectLabels projectId={project.id} labels={labels} canContribute={canContribute} />
        </section>
      )}

      {activeTab === "activity" && (
        <section id="panel-activity" role="tabpanel" className="tab-panel">
          <Activity projectId={project.id} />
        </section>
      )}

      {activeTab === "settings" && canManage && (
        <section id="panel-settings" role="tabpanel" className="tab-panel">
          <ProjectSettings key={project.name} project={project} />
          {project.workspaceKind === "shared" && <ProjectAccess projectId={project.id} />}
        </section>
      )}

      {canContribute && (
        <Drawer
          isOpen={newIssueOpen}
          onOpenChange={setNewIssueOpen}
          purpose="form"
          label="New issue"
          width="28rem"
        >
          <Layout
            height="auto"
            header={
              <DrawerHeader
                title="New issue"
                subtitle={project.name}
                onOpenChange={setNewIssueOpen}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <CreateIssueForm projectId={project.id} />
            </LayoutContent>
          </Layout>
        </Drawer>
      )}

      {canContribute && (
        <Drawer
          isOpen={newKnowledgeOpen}
          onOpenChange={setNewKnowledgeOpen}
          purpose="form"
          label="New knowledge document"
          width="30rem"
        >
          <Layout
            height="auto"
            header={
              <DrawerHeader
                title="New knowledge document"
                subtitle={project.name}
                onOpenChange={setNewKnowledgeOpen}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <CreateKnowledgeForm
                projectId={project.id}
                onCreated={() => setNewKnowledgeOpen(false)}
              />
            </LayoutContent>
          </Layout>
        </Drawer>
      )}
    </main>
  );
}

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
    <Section className="page-section" padding={5}>
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
    <Section className="page-section" padding={5}>
      <Heading level={2} color="inherit">
        Project access
      </Heading>
      {grants.length === 0 ? (
        <Text as="p" display="block" type="supporting">
          No one else has explicit access yet.
        </Text>
      ) : (
        <ul className="row-list">
          {grants.map((grant) => (
            <li key={grant.humanId} data-project-access-for={grant.email} className="row-item">
              <Stack direction="horizontal" className="row-item-main">
                <Text type="inherit" color="inherit" className="row-item-title">
                  {grant.email}
                </Text>
                <span className="meta-pill" data-access-level={grant.level}>
                  {grant.level}
                </span>
                <Text type="supporting">granted by {grant.grantedBy.email}</Text>
              </Stack>
              <Button
                type="button"
                size="sm"
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

function CreateKnowledgeForm({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
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
        onCreated();
        await navigate({ to: "/knowledge/$entryId", params: { entryId: entry.id } });
      }}
    />
  );
}

function Activity({ projectId }: { projectId: string }) {
  const { data: activity } = useSuspenseQuery(projectActivityQuery(projectId));
  if (activity.length === 0) {
    return (
      <Stack className="empty-panel">
        <EmptyState title="No activity yet" headingLevel={3} />
      </Stack>
    );
  }
  return (
    <ul className="row-list">
      {activity.map((event) => (
        <li key={event.id} data-activity-type={event.type} className="row-item">
          <Text type="inherit" color="inherit">
            <strong>{event.actor.displayName}</strong> {activityLabels[event.type]} “{event.summary}
            ”
          </Text>
          <time dateTime={event.createdAt}>{event.createdAt}</time>
        </li>
      ))}
    </ul>
  );
}
