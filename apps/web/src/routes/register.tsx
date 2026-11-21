import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextField } from "../lib/fields.tsx";
import { Button } from "@astryxdesign/core/Button";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, type Session } from "../features/accounts/index.ts";
import {
  declineInstallationInvitation,
  registerThroughInvitation,
} from "../features/invitations/index.ts";

export const Route = createFileRoute("/register")({
  staticData: { accessPage: true },
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

      try {
        await signIn({ email: account.email, password });
      } catch {
        setCreatedEmail(account.email);
        return;
      }

      queryClient.clear();
      const session: Session = {
        signedIn: true,
        email: account.email,
        displayName: null,
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
        <Heading level={1} color="inherit">
          Accept your invitation
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="status">
          Your account was created for {createdEmail}.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/signin">Sign in</Link> with the password you chose.
        </Text>
      </main>
    );
  }

  if (declined) {
    return (
      <main>
        <Heading level={1} color="inherit">
          Accept your invitation
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="status">
          You declined this invitation. The link no longer works.
        </Text>
        <Text as="p" display="block" type="inherit" color="inherit">
          <Link to="/">Go to Orrery</Link>
        </Text>
      </main>
    );
  }

  if (token === "") {
    return (
      <main>
        <Heading level={1} color="inherit">
          Accept your invitation
        </Heading>
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          This invitation link is incomplete. Ask for a fresh invitation.
        </Text>
      </main>
    );
  }

  return (
    <main>
      <Heading level={1} color="inherit">
        Accept your invitation
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        You have been invited to join this Orrery installation.
      </Text>
      <Text as="p" display="block" type="inherit" color="inherit">
        Choose a password to create your account and personal workspace.
      </Text>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Password"
          id="register-password"
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
          isDisabled={submitting || declining}
          label="Register"
          variant="primary"
        />
      </form>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Button
          type="button"
          onClick={() => void onDecline()}
          isDisabled={submitting || declining}
          label="Decline invitation"
          variant="secondary"
        />
      </Text>
    </main>
  );
}
