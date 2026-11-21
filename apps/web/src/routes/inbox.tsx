import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Stack } from "@astryxdesign/core/Stack";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import type { Question } from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";
import { type FormEvent, useState } from "react";
import { sessionQuery } from "../features/accounts/index.ts";
import {
  answerQuestion,
  inboxQuery,
  isPendingQuestion,
  issueQuestionsQuery,
  QuestionDetails,
} from "../features/inbox/index.ts";
import {
  IssueMentionTextArea,
  issueQuery,
  issuesQuery,
  projectQuery,
} from "../features/projects/index.ts";
import { workspaceRunsQuery } from "../features/runs/index.ts";
import { ApiProblemError } from "../lib/api.ts";

export const Route = createFileRoute("/inbox")({
  validateSearch: (search: Record<string, unknown>): { issue?: string } =>
    typeof search.issue === "string" ? { issue: search.issue } : {},
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(inboxQuery);
  },
  component: InboxPage,
  errorComponent: () => (
    <main>
      <Heading level={1} color="inherit">
        Inbox
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit" role="alert">
        Could not load the inbox. Please try again.
      </Text>
    </main>
  ),
});

function InboxPage() {
  const { issue } = Route.useSearch();
  const { data: questions } = useSuspenseQuery({ ...inboxQuery, refetchInterval: 4000 });
  const visible =
    issue === undefined ? questions : questions.filter((question) => question.issueId === issue);
  const open = visible.filter(isPendingQuestion);
  const resolved = visible.filter((question) => !isPendingQuestion(question));

  return (
    <main className="inbox-page">
      <PageHeader
        title="Inbox"
        badge={open.length > 0 ? `${open.length} pending` : undefined}
        subtitle="Questions from agents waiting for your direction."
        actions={
          issue !== undefined ? (
            <Link to="/inbox" search={{}} color="accent" hasUnderline>
              View all questions
            </Link>
          ) : undefined
        }
      />
      {issue !== undefined && (
        <Text as="p" display="block" type="supporting">
          Showing questions for one issue.
        </Text>
      )}
      <QuestionList title="Needs an answer" questions={open} empty="No questions need an answer." />
      <QuestionList title="Resolved" questions={resolved} empty="No resolved questions." />
    </main>
  );
}

function QuestionList({
  title,
  questions,
  empty,
}: {
  title: string;
  questions: Question[];
  empty: string;
}) {
  return (
    <section className="inbox-section">
      <Heading level={2} color="inherit">
        {title}
      </Heading>
      {questions.length === 0 ? (
        <Text as="p" display="block" type="inherit" color="inherit" className="empty-state">
          {empty}
        </Text>
      ) : (
        <ul className="question-list">
          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} />
          ))}
        </ul>
      )}
    </section>
  );
}

function QuestionCard({ question }: { question: Question }) {
  const { data: issue } = useQuery(issueQuery(question.issueId));
  const { data: project } = useQuery(projectQuery(question.projectId));
  const { data: runs = [] } = useQuery(workspaceRunsQuery(question.workspaceId));
  const run = runs.find((entry) => entry.id === question.runId);
  const pending = isPendingQuestion(question);

  return (
    <li className="question-list-item" data-question-id={question.id}>
      <Card className="question-card" data-pending={pending ? "true" : "false"} padding={3}>
        <Stack direction="horizontal" className="question-context">
          <Link
            to="/issues/$issueId"
            params={{ issueId: question.issueId }}
            search={{ inspector: true }}
          >
            {project !== undefined && issue !== undefined && (
              <Text type="inherit" color="inherit" className="issue-key">
                {project.key}-{issue.number}
              </Text>
            )}
            {issue?.title ?? "View issue"}
          </Link>
          {run !== undefined && (
            <Text type="inherit" color="inherit" className="agent-byline">
              Asked by {run.agentName}
            </Text>
          )}
        </Stack>
        <QuestionDetails question={question} />
        {pending && project !== undefined && project.accessLevel !== "read" && (
          <AnswerForm question={question} />
        )}
      </Card>
    </li>
  );
}

function AnswerForm({ question }: { question: Question }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: projectIssues = [] } = useQuery(issuesQuery(question.projectId));
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const resolved = await answerQuestion(question.id, answer);
      queryClient.setQueryData(inboxQuery.queryKey, (current: Question[] | undefined) =>
        current?.map((item) => (item.id === resolved.id ? resolved : item)),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuestionsQuery(question.issueId).queryKey }),
      ]);
      setAnswer("");
      toast({ body: "Answer sent." });
    } catch (cause) {
      setError(
        cause instanceof ApiProblemError
          ? cause.message
          : "Could not submit the answer. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="answer-form"
      onSubmit={(event) => void onSubmit(event)}
      aria-label={`Answer question ${question.id}`}
    >
      <IssueMentionTextArea
        label="Answer"
        id={`answer-${question.id}`}
        htmlName="answer"
        value={answer}
        onChange={setAnswer}
        rows={3}
        required
        issues={projectIssues}
      />
      <Button type="submit" variant="primary" label="Answer question" isLoading={submitting} />
      {error !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {error}
        </Text>
      )}
    </form>
  );
}
