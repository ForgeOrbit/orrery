import { InvitationSummaries } from "@orrery/contract";
import type { InvitationSummary } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

export const installationInvitationsQuery = queryOptions({
  queryKey: ["invitations", "installation"],
  queryFn: async (): Promise<InvitationSummary[] | null> => {
    const res = await fetch("/api/invitations/installation");
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`Installation invitations failed (${res.status}).`);
    return InvitationSummaries.parse(await res.json());
  },
});
