import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Theme } from "@astryxdesign/core/theme";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, useMatches } from "@tanstack/react-router";
import { useState } from "react";
import mark from "../../../../assets/orrery-mark-dark.svg";
import { defaultThemeSlug, themes } from "../astryx-themes.ts";
import { sessionQuery } from "../features/accounts/index.ts";
import { workspacesQuery } from "../features/workspaces/index.ts";
import { AppearancePicker } from "../lib/appearance.tsx";
import { Link } from "../lib/Link.tsx";

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

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NavWorkspacesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function NavMyWorkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.6 8.2 7.2 9.8 10.6 6.4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavInboxIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 9.5 4 3.5h8l1.5 6v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V9.5Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 9.5h3.2l1 1.7h2.6l1-1.7h3.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RootLayout() {
  const accessPage = useMatches({
    select: (matches) => matches.some((match) => match.staticData.accessPage === true),
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
      <header className="mobile-topbar">
        <Theme theme={themes[defaultThemeSlug]} mode="dark">
          <Stack direction="horizontal" className="mobile-topbar-left">
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              label="Open navigation"
              icon={<MenuIcon />}
              onClick={() => setMobileNavOpen(true)}
            />
            <BrandHome />
          </Stack>
        </Theme>
        <AppearancePicker />
      </header>
      <aside className="app-sidebar">
        <BrandHome />
        <SidebarLinks />
        <SidebarFooter />
      </aside>
      <Drawer
        isOpen={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        side="start"
        width="17.5rem"
        label="Navigation"
      >
        <Layout
          height="fill"
          header={<DrawerHeader title="Orrery" onOpenChange={setMobileNavOpen} hasDivider />}
        >
          <LayoutContent>
            <Stack className="mobile-drawer-nav">
              <SidebarLinks onNavigate={() => setMobileNavOpen(false)} />
            </Stack>
          </LayoutContent>
        </Layout>
      </Drawer>
      <Stack className="app-content" id="content" tabIndex={-1}>
        <Outlet />
      </Stack>
    </Stack>
  );
}

function BrandHome() {
  return (
    <Link to="/" className="brand-home" color="inherit">
      <Text type="inherit" color="inherit" className="brand-lockup">
        <img src={mark} width="22" height="20" alt="" />
        Orrery
      </Text>
    </Link>
  );
}

function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { data: workspaces = [] } = useQuery(workspacesQuery);
  const clickProp = onNavigate === undefined ? {} : { onClick: onNavigate };

  return (
    <>
      <nav className="app-nav" aria-label="Main navigation">
        <Link to="/" activeOptions={{ exact: true }} color="inherit" {...clickProp}>
          <span className="nav-item-inner">
            <NavWorkspacesIcon />
            Workspaces
          </span>
        </Link>
        <Link to="/my-work" color="inherit" {...clickProp}>
          <span className="nav-item-inner">
            <NavMyWorkIcon />
            My work
          </span>
        </Link>
        <Link to="/inbox" color="inherit" {...clickProp}>
          <span className="nav-item-inner">
            <NavInboxIcon />
            Inbox
          </span>
        </Link>
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
              color="inherit"
              {...clickProp}
            >
              <span className="nav-item-inner">
                <span className="workspace-nav-dot" aria-hidden="true">
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                {workspace.name}
              </span>
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}

function SidebarFooter() {
  const { data: session } = useQuery(sessionQuery);
  return (
    <footer className="sidebar-footer">
      {session?.signedIn && (
        <Text as="p" display="block" type="supporting" className="sidebar-account">
          {session.email}
        </Text>
      )}
      <AppearancePicker />
    </footer>
  );
}
