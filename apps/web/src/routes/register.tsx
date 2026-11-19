import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, type Session } from "../features/accounts/index.ts";
import { registerThroughInvitation } from "../features/invitations/index.ts";

// The page the invitation email links to (issue #23). Opening it changes nothing: the
// token is redeemed only by the POST the password form sends, and choosing a password
// is what completes registration.
export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: RegisterPage,
});

function RegisterPage() {
  const { token } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const account = await registerThroughInvitation({ token, password });
      // Registered: sign straight in with the credentials just chosen, so following
      // the invitation is one flow, ending inside the new personal workspace.
      await signIn({ email: account.email, password });
      const session: Session = { signedIn: true, email: account.email };
      queryClient.setQueryData(sessionQuery.queryKey, session);
      await navigate({ to: "/" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registration failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  if (token === "") {
    return (
      <main>
        <h1>Accept your invitation</h1>
        <p role="alert">This invitation link is incomplete. Ask for a fresh invitation.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Accept your invitation</h1>
      <p>You have been invited to join this Orrery installation.</p>
      <p>Choose a password to create your account and personal workspace.</p>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="register-password">Password</label>
        <input
          id="register-password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
        />
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          Register
        </button>
      </form>
    </main>
  );
}
