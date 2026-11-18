import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000 } },
});

export const router = createRouter({
  routeTree,
  context: { queryClient },
  // Start loading a route's code and data when its link is hovered.
  defaultPreload: "intent",
  // Loaders read from the Query cache, so the router shouldn't cache on its own.
  defaultPreloadStaleTime: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
