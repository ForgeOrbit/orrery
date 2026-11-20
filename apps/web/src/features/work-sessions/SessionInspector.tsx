import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { sessionActivitiesQuery, sessionsQuery } from "./queries.ts";

// #83: the sidecar inspector on the issue page. It shows one work session's ephemeral
// thought/action/status timeline, following the active session by default and letting a
// human select a past one. Both queries poll every 4s only while the drawer is open and
// the selected session is live (design doc: 3-5s MVP polling). There is no effect: the
// selection is derived during render, and the drawer is a single piece of local state.
export function SessionInspector({
  issueId,
  initialOpen = false,
  initialSessionId,
}: {
  issueId: string;
  initialOpen?: boolean | undefined;
  initialSessionId?: string | undefined;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [pickedId, setPickedId] = useState<string | null>(initialSessionId ?? null);

  const { data: sessions } = useQuery({
    ...sessionsQuery(issueId, open),
    enabled: open,
  });
  const list = sessions ?? [];
  const active = list.find((session) => session.status === "active") ?? null;
  // A stale picker selection (for example after a refetch) falls back to the live session.
  const selectedId = list.some((session) => session.id === pickedId)
    ? pickedId
    : (active?.id ?? list[0]?.id ?? null);
  const selected = list.find((session) => session.id === selectedId) ?? null;
  const activeSelection = open && selected?.status === "active";

  const { data: activities } = useQuery({
    ...sessionActivitiesQuery(issueId, selectedId ?? "", activeSelection),
    enabled: open && selectedId !== null,
  });

  return (
    <section
      data-session-inspector
      style={{ marginTop: "1rem", border: "1px solid #ccc", padding: "0.75rem" }}
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide session inspector" : "Show session inspector"}
      </button>
      {open && (
        <div style={{ marginTop: "0.75rem" }}>
          {list.length === 0 ? (
            <p>No work sessions recorded for this issue.</p>
          ) : (
            <>
              <label htmlFor={`session-inspector-select-${issueId}`}>Work session</label>{" "}
              <select
                id={`session-inspector-select-${issueId}`}
                value={selectedId ?? ""}
                onChange={(event) =>
                  setPickedId(event.target.value === "" ? null : event.target.value)
                }
              >
                {list.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.status} · {session.createdAt}
                    {session.progress === "" ? "" : ` · ${session.progress}`}
                  </option>
                ))}
              </select>
              {selected !== null && (
                <p data-inspector-session-status={selected.status}>
                  Session {selected.id} · {selected.status}
                  {selected.stopRequested ? " · stopping" : ""}
                </p>
              )}
              <h3>Session activity</h3>
              <ol data-activity-timeline>
                {(activities ?? []).length === 0 ? (
                  <li>No activities recorded yet.</li>
                ) : (
                  activities?.map((activity) => (
                    <li
                      key={activity.id}
                      data-activity-id={activity.id}
                      data-activity-kind={activity.kind}
                      style={{ marginBottom: "0.5rem" }}
                    >
                      <strong>{activity.kind}</strong>{" "}
                      <time dateTime={activity.createdAt}>{activity.createdAt}</time>
                      <div data-activity-summary style={{ whiteSpace: "pre-wrap" }}>
                        {activity.summary}
                      </div>
                      {activity.detail !== null && (
                        <pre data-activity-detail>{JSON.stringify(activity.detail, null, 2)}</pre>
                      )}
                    </li>
                  ))
                )}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  );
}
