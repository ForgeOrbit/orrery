import { SmtpSettingsResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

// SMTP settings are administrator-only. A signed-in ordinary account gets 403 and an
// anonymous one 401; both are normal states for the settings page, so null says "this
// account does not manage installation settings" without a second client-side check.
// The server enforces the same boundary for direct clients.
export const smtpSettingsQuery = queryOptions({
  queryKey: ["settings", "smtp"],
  queryFn: async (): Promise<SmtpSettingsResponse | null> => {
    const res = await fetch("/api/settings/smtp");
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`SMTP settings failed (${res.status}).`);
    return SmtpSettingsResponse.parse(await res.json());
  },
});
