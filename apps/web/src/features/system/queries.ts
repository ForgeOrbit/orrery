import { Health } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

export const readinessQuery = queryOptions({
  queryKey: ["readyz"],
  queryFn: async () => Health.parse(await (await fetch("/readyz")).json()),
  refetchInterval: 30_000,
});
