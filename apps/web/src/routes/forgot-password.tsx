import { createFileRoute, Link } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { requestPasswordReset } from "../features/recovery/index.ts";

// The password-recovery request page (issue #31). It shows the server's answer verbatim:
// the response is the same for every address, so this page learns nothing about which
// accounts exist or which have verified email addresses.
export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await requestPasswordReset({ email });
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request a reset link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Reset your password</h1>
      <p>Enter your email address. If it can be recovered, we will send a reset link.</p>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="forgot-email">Email</label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="username"
        />
        {error !== undefined && <p role="alert">{error}</p>}
        {message !== undefined && <p role="status">{message}</p>}
        <button type="submit" disabled={submitting}>
          Send reset link
        </button>
      </form>
      <p>
        <Link to="/signin">Back to sign in</Link>
      </p>
    </main>
  );
}
