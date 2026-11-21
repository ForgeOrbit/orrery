import { SmtpSettingsResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

export const smtpSettingsQuery = queryOptions({
  queryKey: ["settings", "smtp"],
  queryFn: async (): Promise<SmtpSettingsResponse | null> => {
    const res = await fetch("/api/settings/smtp");
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`SMTP settings failed (${res.status}).`);
    return SmtpSettingsResponse.parse(await res.json());
  },
});
