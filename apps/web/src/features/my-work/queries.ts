import { MyWorkResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

// My work (issue #107) is one human-only read, shared by the route loader and the page.
// The page polls it on the MVP's 3-5s cadence; the endpoint owns every scope decision, so
// a revoked grant or suspended membership drops an item from the view on the next poll.
export const myWorkQuery = queryOptions({
  queryKey: ["my-work"],
  queryFn: async () => MyWorkResponse.parse(await getJson("/api/my-work", (value) => value)),
  refetchInterval: 4000,
});
