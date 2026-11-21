import { WorkSession } from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

export function requestStop(issueId: string, reason?: string): Promise<WorkSession> {
  return postJson(
    `/api/issues/${encodeURIComponent(issueId)}/work-sessions/stop-request`,
    reason === undefined || reason.trim() === "" ? {} : { reason },
    (value) => WorkSession.parse(value),
  );
}
