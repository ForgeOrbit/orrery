import { Health } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";

// Query definitions live next to the API they call, so routes and components share one cache key.
// Responses are parsed with the contract's zod schemas, so a server change can't slip through.
export const readinessQuery = queryOptions({
  queryKey: ["readyz"],
  queryFn: async () => Health.parse(await (await fetch("/readyz")).json()),
  refetchInterval: 30_000,
});
