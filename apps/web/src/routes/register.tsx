import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, type Session } from "../features/accounts/index.ts";
import {
  declineInstallationInvitation,
  registerThroughInvitation,
} from "../features/invitations/index.ts";

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
  // Set when registration succeeded but the follow-up sign-in failed: the account
  // exists, so the form is gone and the person is sent to sign in.
  const [createdEmail, setCreatedEmail] = useState<string>();
  const [declined, setDeclined] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onDecline() {
    setDeclining(true);
    setError(undefined);
    try {
      await declineInstallationInvitation({ token });
      setDeclined(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not decline the invitation.");
    } finally {
      setDeclining(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const account = await registerThroughInvitation({ token, password });
      // Registered: sign straight in with the credentials just chosen, so following
      // the invitation is one flow, ending inside the new personal workspace.
      try {
        await signIn({ email: account.email, password });
      } catch {
        // The account was created and the invitation consumed; a resubmit would fail
        // with invitation_invalid. Tell the person, and send them to sign in.
        setCreatedEmail(account.email);
        return;
      }
      // Registration already returns the verified account. Set it infallibly: a
      // transient session-endpoint failure must not strand a consumed token in the
      // generic error path. Clear first so no pre-registration null cache survives.
      queryClient.clear();
      const session: Session = {
        signedIn: true,
        email: account.email,
        emailVerified: account.emailVerified,
      };
      queryClient.setQueryData(sessionQuery.queryKey, session);
      await navigate({ to: "/" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registration failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  if (createdEmail !== undefined) {
    return (
      <main>
        <h1>Accept your invitation</h1>
        <p role="status">Your account was created for {createdEmail}.</p>
        <p>
          <Link to="/signin">Sign in</Link> with the password you chose.
        </p>
      </main>
    );
  }

  if (declined) {
    return (
      <main>
        <h1>Accept your invitation</h1>
        <p role="status">You declined this invitation. The link no longer works.</p>
        <p>
          <Link to="/">Go to Orrery</Link>
        </p>
      </main>
    );
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
        <button type="submit" disabled={submitting || declining}>
          Register
        </button>
      </form>
      <p>
        <button type="button" onClick={() => void onDecline()} disabled={submitting || declining}>
          Decline invitation
        </button>
      </p>
    </main>
  );
}
