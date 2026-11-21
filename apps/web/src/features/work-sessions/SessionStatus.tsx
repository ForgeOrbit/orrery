import { Text } from "@astryxdesign/core/Text";
import { Stack } from "@astryxdesign/core/Stack";
import { TextField } from "../../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { projectActivityQuery } from "../projects/index.ts";
import { requestStop } from "./commands.ts";
import { sessionQuery } from "./queries.ts";

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
    <Stack className="session-status" data-session-id={session.id}>
      <Text type="inherit" color="inherit" data-session-status={status}>
        {status}
      </Text>
      {session.stopRequested && session.stopRequestedAt !== null && (
        <Text type="inherit" color="inherit" data-stop-requested-at={session.stopRequestedAt}>
          {" "}
          · stop requested at {session.stopRequestedAt}
          {session.stopReason !== null && <> · “{session.stopReason}”</>}
        </Text>
      )}
      {canContribute && session.status === "active" && !stopping && (
        <StopAgentForm issueId={issueId} projectId={projectId} />
      )}
    </Stack>
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
    <form className="stop-agent-form" onSubmit={(event) => void onSubmit(event)}>
      {" "}
      <TextField
        label="Reason (optional)"
        id={`stop-reason-${issueId}`}
        htmlName="reason"
        value={reason}
        maxLength={2000}
        onChange={setReason}
        placeholder="Why should the agent stop?"
      />{" "}
      <Button type="submit" isDisabled={submitting} label="Stop agent" variant="destructive" />
      {error !== undefined && (
        <Text type="inherit" color="inherit" role="alert">
          {" "}
          {error}
        </Text>
      )}
    </form>
  );
}
