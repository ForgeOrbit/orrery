import { MyWorkResponse } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

export const myWorkQuery = queryOptions({
  queryKey: ["my-work"],
  queryFn: async () => MyWorkResponse.parse(await getJson("/api/my-work", (value) => value)),
  refetchInterval: 4000,
});
