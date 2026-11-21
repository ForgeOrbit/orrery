import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  issuesQuery,
  projectActivityQuery,
  projectQuery,
  projectTrashQuery,
  readyWorkQuery,
  ResourceLoadError,
  restoreIssue,
} from "../features/projects/index.ts";
import { Link } from "../lib/Link.tsx";

// #98: a Manager's view of the project's 30-day trash. The server owns the window and
// the access check; this route only avoids offering the view to lower levels.
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
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/projects/$projectId" params={{ projectId }}>
          Back to project
        </Link>
      </Text>
      <Heading level={1} color="inherit">
        Trash · {project.name}
      </Heading>
      <Section className="page-section" padding={0}>
        <Heading level={2} color="inherit">
          Recoverable issues
        </Heading>
        {!canManage ? (
          <Text as="p" display="block" type="supporting">
            Only a project manager can view and restore trashed issues.
          </Text>
        ) : trashed === undefined || trashed.length === 0 ? (
          <Text as="p" display="block" type="supporting">
            No issues in the trash.
          </Text>
        ) : (
          <ul>
            {trashed.map((issue) => (
              <li
                key={issue.id}
                data-trashed-issue-id={issue.id}
                data-trashed-identifier={issue.identifier}
              >
                <Text type="inherit" color="inherit" className="issue-key">
                  {issue.identifier}
                </Text>{" "}
                {issue.title}
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
        {error !== undefined && (
          <Text as="p" display="block" type="supporting" role="alert">
            {error}
          </Text>
        )}
      </Section>
    </main>
  );
}
