import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../features/accounts/index.ts";
import { MyWorkErrorState, MyWorkSections, myWorkQuery } from "../features/my-work/index.ts";
import { PageHeader } from "../lib/PageHeader.tsx";

// One daily home screen across workspaces (issue #107). The endpoint decides what is in
// scope; this page only polls it and renders the three sections. No useEffect: data comes
// from the query, which refetches every four seconds while the page is open.
export const Route = createFileRoute("/my-work")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(myWorkQuery);
  },
  component: MyWorkPage,
  pendingComponent: MyWorkLoadingState,
  errorComponent: ({ error }) => <MyWorkErrorState error={error} />,
});

function MyWorkLoadingState() {
  return (
    <main data-my-work-loading>
      <PageHeader title="My work" />
      <Text as="p" display="block" type="supporting" role="status">
        Loading your work…
      </Text>
    </main>
  );
}

function MyWorkPage() {
  const work = useQuery(myWorkQuery);

  if (work.isPending) return <MyWorkLoadingState />;

  if (work.isError) return <MyWorkErrorState error={work.error} />;

  return (
    <main data-my-work-page>
      <PageHeader
        title="My work"
        subtitle="Your assignments, live agent sessions, and questions across all your workspaces."
      />
      <MyWorkSections work={work.data} />
    </main>
  );
}
