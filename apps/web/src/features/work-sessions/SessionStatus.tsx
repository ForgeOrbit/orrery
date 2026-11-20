import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { projectActivityQuery } from "../projects/index.ts";
import { requestStop } from "./commands.ts";
import { sessionQuery } from "./queries.ts";

// #82: one issue's current work session. A stop request is a signal on an *active*
// session, not a terminal status, so the badge shows "stopping" until the agent
// acknowledges the request or the five-minute lease expires. The same control is used on
// the issue page and in the agents view so both surfaces agree.
export function SessionStatus({
  issueId,
  projectId,
  canContribute,
}: {
  issueId: string;
  projectId: string;
  canContribute: boolean;
}) {
  const { data: session } = useQuery(sessionQuery(issueId));

  if (session === null || session === undefined) return null;

  const stopping = session.status === "active" && session.stopRequested;
  const status = stopping ? "stopping" : session.status;

  return (
    <span className="session-status" data-session-id={session.id}>
      <span data-session-status={status}>{status}</span>
      {session.stopRequested && session.stopRequestedAt !== null && (
        <span data-stop-requested-at={session.stopRequestedAt}>
          {" "}
          · stop requested at {session.stopRequestedAt}
          {session.stopReason !== null && <> · “{session.stopReason}”</>}
        </span>
      )}
      {canContribute && session.status === "active" && !stopping && (
        <StopAgentForm issueId={issueId} projectId={projectId} />
      )}
    </span>
  );
}

function StopAgentForm({ issueId, projectId }: { issueId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      // Set the returned session into the cache first: the badge flips to "stopping"
      // immediately from the server's own answer, with no local guess about the status.
      const updated = await requestStop(issueId, reason);
      queryClient.setQueryData(sessionQuery(issueId).queryKey, updated);
      await queryClient.invalidateQueries({
        queryKey: projectActivityQuery(projectId).queryKey,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request a stop.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="stop-agent-form"
      onSubmit={(event) => void onSubmit(event)}
      style={{ display: "inline", marginInlineStart: "0.5rem" }}
    >
      <label htmlFor={`stop-reason-${issueId}`}>Reason (optional)</label>{" "}
      <input
        id={`stop-reason-${issueId}`}
        name="reason"
        value={reason}
        maxLength={2000}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why should the agent stop?"
      />{" "}
      <button type="submit" disabled={submitting}>
        Stop agent
      </button>
      {error !== undefined && <span role="alert"> {error}</span>}
    </form>
  );
}
