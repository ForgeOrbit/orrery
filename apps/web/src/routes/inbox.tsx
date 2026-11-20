import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import type { Question } from "@orrery/contract";
import { sessionQuery } from "../features/accounts/index.ts";
import { answerQuestion, inboxQuery } from "../features/inbox/index.ts";
import { ApiProblemError } from "../lib/api.ts";

export const Route = createFileRoute("/inbox")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(inboxQuery);
  },
  component: InboxPage,
  errorComponent: () => <p>Could not load the inbox. Please try again.</p>,
});

function InboxPage() {
  const { data: questions } = useSuspenseQuery(inboxQuery);
  const open = questions.filter(
    (question) => question.status === "open" || question.status === "paused",
  );
  const resolved = questions.filter(
    (question) => question.status !== "open" && question.status !== "paused",
  );

  return (
    <main>
      <h1>Inbox</h1>
      <p>
        Questions from agents that need a human answer. Only contributors and managers can answer.
      </p>
      <h2>Needs an answer</h2>
      {open.length === 0 ? (
        <p>No questions need an answer.</p>
      ) : (
        <ul>
          {open.map((question) => (
            <li key={question.id} data-question-id={question.id}>
              <QuestionDetails question={question} />
              <AnswerForm question={question} />
            </li>
          ))}
        </ul>
      )}
      <h2>Resolved</h2>
      {resolved.length === 0 ? (
        <p>No resolved questions.</p>
      ) : (
        <ul>
          {resolved.map((question) => (
            <li key={question.id} data-question-id={question.id}>
              <QuestionDetails question={question} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function QuestionDetails({ question }: { question: Question }) {
  return (
    <div>
      <p data-question-status={question.status}>
        {question.status === "paused" ? "Paused" : question.status} · due{" "}
        {question.responseDeadlineAt}
      </p>
      <p data-question-text>{question.question}</p>
      <p>Proposed fallback: {question.proposedFallback}</p>
      {question.answer !== null && <p data-question-answer>Answer: {question.answer}</p>}
      {question.followUp !== null && <p data-question-follow-up>Follow-up: {question.followUp}</p>}
    </div>
  );
}

function AnswerForm({ question }: { question: Question }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const resolved = await answerQuestion(question.id, answer);
      queryClient.setQueryData(inboxQuery.queryKey, (current: Question[] | undefined) =>
        current?.map((item) => (item.id === resolved.id ? resolved : item)),
      );
      await queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey });
      setAnswer("");
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
    <form onSubmit={(event) => void onSubmit(event)} aria-label={`Answer question ${question.id}`}>
      <label htmlFor={`answer-${question.id}`}>Answer</label>
      <textarea
        id={`answer-${question.id}`}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        rows={3}
        required
      />
      <button type="submit" disabled={submitting}>
        Answer question
      </button>
      {error !== undefined && <p role="alert">{error}</p>}
    </form>
  );
}
