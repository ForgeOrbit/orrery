import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
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
      <h1>Sign in</h1>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="signin-email">Email</label>
        <input
          id="signin-email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="username"
        />
        <label htmlFor="signin-password">Password</label>
        <input
          id="signin-password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete="current-password"
        />
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          Sign in
        </button>
      </form>
      <p>
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
    </main>
  );
}
