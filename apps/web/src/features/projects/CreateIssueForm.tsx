import { useToast } from "@astryxdesign/core/Toast";
import type { Issue, IssueDetail } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createIssue } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery, readyWorkQuery } from "./queries.ts";
import { TitleBodyForm } from "./TitleBodyForm.tsx";

export function CreateIssueForm({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated?: (issue: Issue) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  return (
    <TitleBodyForm
      idPrefix="issue"
      titleLabel="Issue title"
      bodyLabel="Description"
      bodyRows={4}
      submitLabel="Create issue"
      fallbackError="Could not create the issue."
      resetOnSuccess
      onSubmit={async ({ title, body }) => {
        const issue = await createIssue(projectId, { title, body });
        // A new issue has no links yet; seed the detail cache the loader will read.
        queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, {
          ...issue,
          links: [],
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
          queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
          queryClient.invalidateQueries({ queryKey: readyWorkQuery(projectId).queryKey }),
        ]);
        toast({ body: `Created ${issue.identifier}.` });
        if (onCreated) onCreated(issue);
        else await navigate({ to: "/issues/$issueId", params: { issueId: issue.id } });
      }}
    />
  );
}
