import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextField } from "../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import type { FormEvent } from "react";
import { useState } from "react";
import { requestPasswordReset } from "../features/recovery/index.ts";

export const Route = createFileRoute("/forgot-password")({
  staticData: { accessPage: true },
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
      <Heading level={1} color="inherit">
        Reset your password
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        Enter your email address. If it can be recovered, we will send a reset link.
      </Text>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Email"
          id="forgot-email"
          htmlName="email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="username"
        />
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        {message !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="status">
            {message}
          </Text>
        )}
        <Button type="submit" isDisabled={submitting} label="Send reset link" variant="primary" />
      </form>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/signin" className="back-link-inline">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M12.5 8h-9M7 4.5 3.5 8 7 11.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back to sign in
        </Link>
      </Text>
    </main>
  );
}
