import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  issueQuery,
  issuesQuery,
  projectActivityQuery,
  projectQuery,
  projectTrashQuery,
  readyWorkQuery,
  ResourceLoadError,
  restoreIssue,
} from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/trash/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    if (project.accessLevel === "manage") {
      await context.queryClient.ensureQueryData(projectTrashQuery(project.id));
    }
  },
  component: ProjectTrashPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="trash" error={error} />,
});

function ProjectTrashPage() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const canManage = project.accessLevel === "manage";
  const { data: trashed } = useQuery({ ...projectTrashQuery(projectId), enabled: canManage });
  const [error, setError] = useState<string>();
  const [restoring, setRestoring] = useState(false);

  async function onRestore(issueId: string) {
    setRestoring(true);
    setError(undefined);
    try {
      await restoreIssue(issueId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectTrashQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore the issue.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          <Link key="project" to="/projects/$projectId" params={{ projectId }}>
            Back to project
          </Link>,
        ]}
        title="Trash"
        badge={project.name}
        subtitle="Soft-deleted issues stay recoverable for 30 days."
      />
      {error !== undefined && (
        <Text as="p" display="block" type="supporting" role="alert">
          {error}
        </Text>
      )}
      {!canManage ? (
        <Stack className="empty-panel">
          <EmptyState
            title="Manager access required"
            description="Only a project manager can view and restore trashed issues."
            headingLevel={2}
          />
        </Stack>
      ) : trashed === undefined || trashed.length === 0 ? (
        <Stack className="empty-panel">
          <EmptyState
            title="No issues in the trash"
            description="Issues moved to trash will appear here for 30 days."
            headingLevel={2}
          />
        </Stack>
      ) : (
        <ul className="row-list">
          {trashed.map((issue) => (
            <li
              key={issue.id}
              data-trashed-issue-id={issue.id}
              data-trashed-identifier={issue.identifier}
              className="row-item"
            >
              <Stack direction="horizontal" className="row-item-main">
                <Text type="inherit" color="inherit" className="issue-key">
                  {issue.identifier}
                </Text>
                <Text type="inherit" color="inherit" className="row-item-title">
                  {issue.title}
                </Text>
              </Stack>
              <Button
                type="button"
                label={`Restore ${issue.identifier}`}
                variant="secondary"
                size="sm"
                isDisabled={restoring}
                data-restore-button
                onClick={() => void onRestore(issue.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
