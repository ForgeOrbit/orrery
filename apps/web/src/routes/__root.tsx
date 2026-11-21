import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Stack } from "@astryxdesign/core/Stack";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, useMatches } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import mark from "../../../../assets/orrery-mark-dark.svg";
import { workspacesQuery } from "../features/workspaces/index.ts";
import { AppearancePicker } from "../lib/appearance.tsx";

export interface RouterContext {
  queryClient: QueryClient;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    accessPage?: boolean;
  }
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: () => (
    <main>
      <Heading level={1} color="inherit">
        Page not found
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        Check the address or return to your workspaces.
      </Text>
      <Link to="/">Go to your workspaces</Link>
    </main>
  ),
});

function RootLayout() {
  const accessPage = useMatches({
    select: (matches) => matches.some((match) => match.staticData.accessPage === true),
  });

  if (accessPage) {
    return (
      <Stack className="access-layout">
        <aside className="access-cover">
          <header className="access-toolbar">
            <BrandHome />
            <AppearancePicker />
          </header>
          <Stack className="orbit-diagram" aria-hidden="true">
            <span />
            <span />
            <span />
          </Stack>
          <Stack className="access-cover-copy">
            <Text as="p" display="block" type="inherit" color="inherit">
              Projects for humans and agents.
            </Text>
            <small>
              Track issues, share knowledge, and give agents direction when they need it.
            </small>
          </Stack>
        </aside>
        <Stack className="access-content">
          <Outlet />
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack className="app-layout">
      <AstryxLink className="skip-link" href="#content">
        Skip to content
      </AstryxLink>
      <WorkspaceNavigation />
      <Stack className="app-content" id="content" tabIndex={-1}>
        <Outlet />
      </Stack>
    </Stack>
  );
}

function BrandHome() {
  return (
    <Link to="/" className="brand-home">
      <Text type="inherit" color="inherit" className="brand-lockup">
        <img src={mark} width="25" height="22" alt="" />
        Orrery
      </Text>
    </Link>
  );
}

function WorkspaceNavigation() {
  const { data: workspaces = [] } = useQuery(workspacesQuery);

  return (
    <aside className="app-sidebar">
      <BrandHome />
      <nav className="app-nav" aria-label="Main navigation">
        <Link to="/" activeOptions={{ exact: true }}>
          Workspaces
        </Link>
        <Link to="/my-work">My work</Link>
        <Link to="/inbox">Inbox</Link>
      </nav>
      {workspaces.length > 0 && (
        <nav className="app-nav workspace-nav" aria-label="Your workspaces">
          <Text as="p" display="block" type="inherit" color="inherit">
            Your workspaces
          </Text>
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              to="/workspaces/$workspaceId"
              params={{ workspaceId: workspace.id }}
            >
              {workspace.name}
            </Link>
          ))}
        </nav>
      )}
      <AppearancePicker />
    </aside>
  );
}
