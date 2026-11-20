import { WorkSession } from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

// A human-only action: ask the agent holding the live session to stop (#82). The server
// refuses agent keys, Readers and non-members; the reason is optional and may be empty.
export function requestStop(issueId: string, reason?: string): Promise<WorkSession> {
  return postJson(
    `/api/issues/${encodeURIComponent(issueId)}/work-sessions/stop-request`,
    reason === undefined || reason.trim() === "" ? {} : { reason },
    (value) => WorkSession.parse(value),
  );
}
