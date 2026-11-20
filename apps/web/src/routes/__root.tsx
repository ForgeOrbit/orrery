import type { QueryClient } from "@tanstack/react-query";
import { Link, Outlet, createRootRouteWithContext } from "@tanstack/react-router";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: () => <p>Page not found.</p>,
});

function RootLayout() {
  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <nav>
        <Link to="/">Orrery</Link> <Link to="/inbox">Inbox</Link>
      </nav>
      <Outlet />
    </div>
  );
}
