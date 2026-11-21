import { Text } from "@astryxdesign/core/Text";
import { Stack } from "@astryxdesign/core/Stack";
import type { Question } from "@orrery/contract";

const statusLabels = {
  open: "Needs input",
  paused: "Paused",
  answered: "answered",
  fallback_used: "Fallback used",
} satisfies Record<Question["status"], string>;

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function isPendingQuestion(question: Question) {
  return question.status === "open" || question.status === "paused";
}

export function QuestionDetails({ question }: { question: Question }) {
  const deadline = question.responseDeadlineAt;

  return (
    <Stack className="question-details">
      <Stack direction="horizontal" className="question-meta">
        <Text type="inherit" color="inherit" data-question-status={question.status}>
          {statusLabels[question.status]}
        </Text>
        <Text type="inherit" color="inherit">
          {question.status === "open" ? "Due" : "Deadline"}{" "}
          <time dateTime={deadline}>{dateTime.format(new Date(deadline))}</time>
        </Text>
      </Stack>
      <Text
        as="p"
        display="block"
        type="inherit"
        color="inherit"
        className="question-text"
        data-question-text
      >
        {question.question}
      </Text>
      <dl className="question-outcome">
        <dt>{question.authorizedFallback === null ? "Proposed fallback" : "Fallback used"}</dt>
        <dd>{question.authorizedFallback ?? question.proposedFallback}</dd>
        {question.answer !== null && (
          <>
            <dt>Answer</dt>
            <dd data-question-answer>{question.answer}</dd>
          </>
        )}
        {question.followUp !== null && (
          <>
            <dt>Follow-up</dt>
            <dd data-question-follow-up>{question.followUp}</dd>
          </>
        )}
      </dl>
    </Stack>
  );
}
