import { InboxResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

// The human input inbox: one query definition, one cache key, shared by the route loader
// and the page. Responses are parsed with the shared contract.
export const inboxQuery = queryOptions({
  queryKey: ["inbox"],
  queryFn: async () => InboxResponse.parse(await getJson("/api/inbox", (value) => value)),
});

export const issueQuestionsQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "questions"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/questions`, (value) =>
        InboxResponse.parse(value),
      ),
    refetchInterval: 4000,
  });
