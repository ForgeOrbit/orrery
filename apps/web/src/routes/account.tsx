import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  changePassword,
  sessionQuery,
  signOut,
  updateProfile,
} from "../features/accounts/index.ts";
import { AppearancePicker } from "../lib/appearance.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/account")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  component: AccountPage,
});

function AccountPage() {
  const { data: session, isPending, isError } = useQuery(sessionQuery);

  if (isPending) {
    return (
      <main>
        <Text as="p" display="block" type="inherit" color="inherit">
          Loading…
        </Text>
      </main>
    );
  }
  if (isError || !session.signedIn) {
    return (
      <main>
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          Could not check your session. Try reloading.
        </Text>
      </main>
    );
  }

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          <Link key="home" to="/">
            Workspaces
          </Link>,
          <span key="account">Account</span>,
        ]}
        title={session.displayName ?? "Account"}
        subtitle={session.email}
        badge={session.emailVerified ? "Email verified" : "Email unverified"}
      />
      <ProfileSection initialDisplayName={session.displayName} />
      <PasswordSection />
      <PreferencesSection />
      <SessionSection />
    </main>
  );
}

function ProfileSection({ initialDisplayName }: { initialDisplayName: string | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draftDisplayName, setDraftDisplayName] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const displayName = draftDisplayName ?? initialDisplayName ?? "";

  const mutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: async () => {
      setDraftDisplayName(null);
      setSavedMessage("Profile saved.");
      toast({ body: "Profile saved." });
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
    onError: (error) => {
      toast({ body: error.message, type: "error" });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSavedMessage(null);
    const trimmed = displayName.trim();
    mutation.mutate({ displayName: trimmed.length === 0 ? null : trimmed });
  }

  return (
    <section className="page-section">
      <Heading level={2} color="inherit">
        Profile
      </Heading>
      <Text as="p" display="block" type="supporting">
        Set the display name shown in your sidebar and account header. Leave it blank to show your
        email address instead.
      </Text>
      <form onSubmit={onSubmit}>
        <TextInput
          id="account-display-name"
          label="Display name"
          placeholder="Your name"
          value={displayName}
          onChange={(value) => {
            setDraftDisplayName(value);
            setSavedMessage(null);
          }}
        />
        <Button
          type="submit"
          label={mutation.isPending ? "Saving…" : "Save profile"}
          isLoading={mutation.isPending}
        />
        {savedMessage !== null && (
          <Text as="p" display="block" type="supporting" role="status">
            {savedMessage}
          </Text>
        )}
        {mutation.isError && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {mutation.error.message}
          </Text>
        )}
      </form>
    </section>
  );
}

function PasswordSection() {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setClientError(null);
      const msg = "Password updated. Other browser sessions have been signed out.";
      setSavedMessage(msg);
      toast({ body: msg });
    },
    onError: (error) => {
      toast({ body: error.message, type: "error" });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSavedMessage(null);
    if (newPassword !== confirmPassword) {
      setClientError("New passwords do not match.");
      return;
    }
    setClientError(null);
    mutation.mutate({ currentPassword, newPassword });
  }

  const errorMessage = clientError ?? (mutation.isError ? mutation.error.message : null);

  return (
    <section className="page-section">
      <Heading level={2} color="inherit">
        Password
      </Heading>
      <Text as="p" display="block" type="supporting">
        Changing your password signs out all other browsers while keeping this session signed in.
      </Text>
      <form onSubmit={onSubmit}>
        <TextInput
          id="account-current-password"
          type="password"
          label="Current password"
          autoComplete="current-password"
          isRequired
          value={currentPassword}
          onChange={setCurrentPassword}
        />
        <TextInput
          id="account-new-password"
          type="password"
          label="New password"
          autoComplete="new-password"
          isRequired
          value={newPassword}
          onChange={setNewPassword}
        />
        <TextInput
          id="account-confirm-password"
          type="password"
          label="Confirm new password"
          autoComplete="new-password"
          isRequired
          value={confirmPassword}
          onChange={setConfirmPassword}
        />
        <Button
          type="submit"
          label={mutation.isPending ? "Updating…" : "Update password"}
          isLoading={mutation.isPending}
        />
        {savedMessage !== null && (
          <Text as="p" display="block" type="supporting" role="status">
            {savedMessage}
          </Text>
        )}
        {errorMessage !== null && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {errorMessage}
          </Text>
        )}
      </form>
    </section>
  );
}

function PreferencesSection() {
  return (
    <section className="page-section">
      <Heading level={2} color="inherit">
        Appearance
      </Heading>
      <Text as="p" display="block" type="supporting">
        Choose how Orrery looks in this browser: follow your system theme, light mode, or dark mode.
      </Text>
      <Stack>
        <AppearancePicker />
      </Stack>
    </section>
  );
}

function SessionSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      queryClient.clear();
      toast({ body: "Signed out." });
      await navigate({ to: "/signin", replace: true });
    },
    onError: (error) => {
      toast({ body: error.message, type: "error" });
    },
  });

  return (
    <section className="page-section">
      <Heading level={2} color="inherit">
        Session
      </Heading>
      <Text as="p" display="block" type="supporting">
        Sign out of Orrery on this browser.
      </Text>
      <Button
        type="button"
        variant="secondary"
        label={logout.isPending ? "Signing out…" : "Sign out"}
        isLoading={logout.isPending}
        onClick={() => logout.mutate()}
      />
      {logout.isError && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {logout.error.message}
        </Text>
      )}
    </section>
  );
}
