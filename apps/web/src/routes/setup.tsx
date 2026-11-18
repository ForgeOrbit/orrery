import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { createFirstAdministrator, setupStatusQuery } from "../features/accounts/index.ts";

// Initial setup: the installer creates the first system administrator, protected by the
// deployment's bootstrap secret. The page only exists while setup is open.
export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery);
    if (status.setupComplete) throw redirect({ to: "/signin" });
  },
  component: SetupPage,
});

function SetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [secret, setSecret] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await createFirstAdministrator({ secret, email, password });
      // The server closed setup; keep the query cache in step before navigating.
      queryClient.setQueryData(setupStatusQuery.queryKey, { setupComplete: true });
      await navigate({ to: "/signin" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Set up Orrery</h1>
      <p>Create the first system administrator. This can be done only once.</p>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="setup-secret">Setup secret</label>
        <input
          id="setup-secret"
          name="secret"
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          required
          autoComplete="off"
        />
        <p>Supplied by the installer through the server's BOOTSTRAP_SECRET setting.</p>
        <label htmlFor="setup-email">Email</label>
        <input
          id="setup-email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="username"
        />
        <label htmlFor="setup-password">Password</label>
        <input
          id="setup-password"
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
          Create administrator
        </button>
      </form>
    </main>
  );
}
