import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextField } from "../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import type { FormEvent } from "react";
import { useState } from "react";
import { confirmPasswordReset } from "../features/recovery/index.ts";

export const Route = createFileRoute("/reset-password")({
  staticData: { accessPage: true },
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
        <Heading level={1} color="inherit">
          Choose a new password
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          This reset link is incomplete. Ask for a fresh reset link.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/forgot-password">Request a reset link</Link>
        </Text>
      </main>
    );
  }

  return (
    <main>
      <Heading level={1} color="inherit">
        Choose a new password
      </Heading>
      {message !== undefined ? (
        <>
          <Text as="p" display="block" type="inherit" color="inherit" role="status">
            {message}
          </Text>
          <Text as="p" display="block" type="inherit" color="inherit">
            <Link to="/signin">Sign in</Link>
          </Text>
        </>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)}>
          <TextField
            label="New password"
            id="reset-password"
            htmlName="password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            minLength={8}
            autoComplete="new-password"
          />
          {error !== undefined && (
            <Text as="p" display="block" type="inherit" color="inherit" role="alert">
              {error}
            </Text>
          )}
          <Button
            type="submit"
            isDisabled={submitting}
            label="Set new password"
            variant="primary"
          />
        </form>
      )}
    </main>
  );
}
