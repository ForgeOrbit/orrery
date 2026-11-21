import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextField } from "../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn } from "../features/accounts/index.ts";

// Only the internal workspace-invitation path is accepted as a post-sign-in destination.
// It is not a general redirect: complete URLs, schemes, and every other route are ignored.
const INVITATION_NEXT = /^\/workspace-invitation\?token=([A-Za-z0-9_-]+)$/;

function invitationTokenFrom(next: string | undefined): string | undefined {
  if (next === undefined) return undefined;
  return INVITATION_NEXT.exec(next)?.[1];
}

export const Route = createFileRoute("/signin")({
  staticData: { accessPage: true },
  validateSearch: (search: Record<string, unknown>) => {
    const next =
      typeof search.next === "string" && INVITATION_NEXT.test(search.next)
        ? search.next
        : undefined;
    return next === undefined ? {} : { next };
  },
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (session.signedIn) throw redirect({ to: "/" });
  },
  component: SignInPage,
});

function SignInPage() {
  const { next } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await signIn({ email, password });
      // Anything cached while signed out (notably an anonymous smtpSettingsQuery of
      // null) must not survive the new identity: with staleTime, ensureQueryData would
      // otherwise keep serving that refusal after sign-in. Login also only answers with
      // the email, so fetch the session from the server for the verified state.
      queryClient.clear();
      await queryClient.fetchQuery(sessionQuery);
      const token = invitationTokenFrom(next);
      if (token !== undefined) {
        await navigate({ to: "/workspace-invitation", search: { token } });
      } else {
        await navigate({ to: "/" });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <Heading level={1} color="inherit">
        Sign in
      </Heading>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Email"
          id="signin-email"
          htmlName="email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="username"
        />

        <TextField
          label="Password"
          id="signin-password"
          htmlName="password"
          type="password"
          value={password}
          onChange={setPassword}
          required
          autoComplete="current-password"
        />
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        <Button type="submit" isDisabled={submitting} label="Sign in" variant="primary" />
      </form>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/forgot-password">Forgot your password?</Link>
      </Text>
    </main>
  );
}
