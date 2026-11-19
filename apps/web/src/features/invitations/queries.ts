import { InvitationSummaries } from "@orrery/contract";
import type { InvitationSummary } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

// Installation invitations are administrator-only. A signed-in ordinary account gets
// 403, which is a normal state for the page's optional section, not an error; null says
// "this account does not manage installation invitations".
export const installationInvitationsQuery = queryOptions({
  queryKey: ["invitations", "installation"],
  queryFn: async (): Promise<InvitationSummary[] | null> => {
    const res = await fetch("/api/invitations/installation");
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`Installation invitations failed (${res.status}).`);
    return InvitationSummaries.parse(await res.json());
  },
});
