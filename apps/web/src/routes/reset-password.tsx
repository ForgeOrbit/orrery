import { createFileRoute, Link } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { confirmPasswordReset } from "../features/recovery/index.ts";

// The page the reset email links to (issue #31). Opening it changes nothing: the token
// is redeemed only by the POST the password form sends. A successful reset also signs
// out the account's old browser sessions, so this page sends people back to sign in.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await confirmPasswordReset({ token, password });
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset the password.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  if (token === "") {
    return (
      <main>
        <h1>Choose a new password</h1>
        <p role="alert">This reset link is incomplete. Ask for a fresh reset link.</p>
        <p>
          <Link to="/forgot-password">Request a reset link</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Choose a new password</h1>
      {message !== undefined ? (
        <>
          <p role="status">{message}</p>
          <p>
            <Link to="/signin">Sign in</Link>
          </p>
        </>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)}>
          <label htmlFor="reset-password">New password</label>
          <input
            id="reset-password"
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
            Set new password
          </button>
        </form>
      )}
    </main>
  );
}
