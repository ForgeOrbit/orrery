import { MarkAllReadResponse } from "@orrery/contract";
import { post, postNoContent } from "../../lib/api.ts";

export function markNotificationRead(id: string): Promise<void> {
  return postNoContent(`/api/notifications/${encodeURIComponent(id)}/read`, {});
}

export function markAllNotificationsRead(): Promise<MarkAllReadResponse> {
  return post("/api/notifications/read-all", (value) => MarkAllReadResponse.parse(value));
}
