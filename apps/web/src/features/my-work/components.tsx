import { Banner } from "@astryxdesign/core/Banner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  type MyWorkActiveSession,
  type MyWorkAssignedIssue,
  type MyWorkQuestion,
  type MyWorkResponse,
} from "@orrery/contract";
import type { ReactNode } from "react";
import { issueStatusLabels, PriorityBadge } from "../projects/index.ts";
import { Link } from "../../lib/Link.tsx";
import { ApiProblemError } from "../../lib/api.ts";

const number = new Intl.NumberFormat();

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

export function MyWorkSections({ work }: { work: MyWorkResponse }) {
  return (
    <Stack className="section-stack">
      <MyWorkSection title="Assigned to me" section="assigned-issues">
        {work.assignedIssues.length === 0 ? (
          <EmptyState
            title="Nothing assigned to you"
            description="Open issues assigned to you appear here across all your workspaces."
            isCompact
            headingLevel={3}
          />
        ) : (
          <List hasDividers>
            {work.assignedIssues.map((issue) => (
              <AssignedIssueRow key={issue.id} issue={issue} />
            ))}
          </List>
        )}
      </MyWorkSection>

      <MyWorkSection title="My active agent sessions" section="active-sessions">
        {work.activeAgentSessions.length === 0 ? (
          <EmptyState
            title="No active agent sessions"
            description="Live sessions running under your agents appear here as soon as they claim an issue."
            isCompact
            headingLevel={3}
          />
        ) : (
          <List hasDividers>
            {work.activeAgentSessions.map((session) => (
              <ActiveSessionRow key={session.sessionId} session={session} />
            ))}
          </List>
        )}
      </MyWorkSection>

      <MyWorkSection title="Needs input" section="needs-input">
        {work.needsInputQuestions.length === 0 ? (
          <EmptyState
            title="No questions need your input"
            description="Open or paused questions on your projects appear here with a link to answer them."
            isCompact
            headingLevel={3}
          />
        ) : (
          <List hasDividers>
            {work.needsInputQuestions.map((question) => (
              <QuestionRow key={question.id} question={question} />
            ))}
          </List>
        )}
      </MyWorkSection>
    </Stack>
  );
}

function MyWorkSection({
  title,
  section,
  children,
}: {
  title: string;
  section: string;
  children: ReactNode;
}) {
  return (
    <Section className="page-section" data-my-work-section={section} padding={3}>
      <Heading level={2} color="inherit">
        {title}
      </Heading>
      {children}
    </Section>
  );
}

function AssignedIssueRow({ issue }: { issue: MyWorkAssignedIssue }) {
  return (
    <ListItem
      data-my-work-issue-id={issue.id}
      itemKey={issue.id}
      label={
        <Link to="/issues/$issueId" params={{ issueId: issue.id }}>
          {issue.identifier} {issue.title}
        </Link>
      }
      description={
        <Text type="supporting" color="inherit">
          {issue.workspaceName} · {issue.projectName} · {issueStatusLabels[issue.status]}
          {issue.needsInput ? " · Needs input" : ""}
        </Text>
      }
      endContent={<PriorityBadge priority={issue.priority} />}
    />
  );
}

function ActiveSessionRow({ session }: { session: MyWorkActiveSession }) {
  const telemetry = [
    session.inputTokens === null ? undefined : `${number.format(session.inputTokens)} input tokens`,
    session.outputTokens === null
      ? undefined
      : `${number.format(session.outputTokens)} output tokens`,
    session.costUsdMicros === null
      ? undefined
      : `${currency.format(session.costUsdMicros / 1_000_000)} cost`,
  ].filter((part) => part !== undefined);

  return (
    <ListItem
      data-my-work-session-id={session.sessionId}
      itemKey={session.sessionId}
      label={
        <Link to="/issues/$issueId" params={{ issueId: session.issueId }}>
          {session.issueIdentifier} {session.issueTitle}
        </Link>
      }
      description={
        <Text type="supporting" color="inherit">
          {session.workspaceName} · {session.projectName} · {session.agentName} · Harness{" "}
          {session.harness ?? "unknown"} · Model {session.model ?? "unknown"}
          {telemetry.length > 0 ? ` · ${telemetry.join(" · ")}` : ""}
        </Text>
      }
      endContent={
        session.stopRequestedAt === null ? undefined : (
          <Text type="inherit" color="inherit" data-session-status="stopping">
            Stop requested
          </Text>
        )
      }
    />
  );
}

function QuestionRow({ question }: { question: MyWorkQuestion }) {
  return (
    <ListItem
      data-my-work-question-id={question.id}
      itemKey={question.id}
      label={question.question}
      description={
        <Text type="supporting" color="inherit">
          {question.workspaceName} · {question.projectName} · {question.issueIdentifier}{" "}
          {question.issueTitle} · {question.agentName} · {question.status}
        </Text>
      }
      endContent={
        <Link to="/inbox" search={{ issue: question.issueId }}>
          Answer in Inbox
        </Link>
      }
    />
  );
}

export function MyWorkErrorState({ error }: { error: unknown }) {
  const problem = error instanceof ApiProblemError ? error.problem : undefined;

  return (
    <main data-my-work-error>
      <Heading level={1} color="inherit">
        My work
      </Heading>
      <Banner
        container="section"
        status="error"
        title={problem?.title ?? "Could not load My work"}
        description={
          problem === undefined
            ? "Check your connection and try again."
            : (problem.errors?.[0]?.detail ?? problem.detail)
        }
        collapsible={false}
      />
      <Text as="p" display="block" type="inherit" color="inherit" role="alert">
        {problem === undefined
          ? "Could not load My work. Please try again."
          : `Problem: ${problem.code} (${problem.status})`}
      </Text>
    </main>
  );
}
