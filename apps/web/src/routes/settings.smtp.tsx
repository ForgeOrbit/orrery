import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Section } from "@astryxdesign/core/Section";
import { TextField } from "../lib/fields.tsx";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "../lib/Link.tsx";
import {
  SmtpSecurity,
  type SmtpSettings as SmtpSettingsInput,
  type SmtpSettingsResponse,
} from "@orrery/contract";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, type Session } from "../features/accounts/index.ts";
import {
  saveSmtpSettings,
  sendTestEmail,
  smtpSettingsQuery,
  verifyEmail,
} from "../features/settings/index.ts";

// SMTP configuration and email verification (issue #22), for system administrators.
// The query answers null for anyone else, so the page shows a plain refusal instead of a
// repeated failed request; the server enforces the same boundary for direct clients.
export const Route = createFileRoute("/settings/smtp")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(smtpSettingsQuery),
    ]);
  },
  component: SmtpSettingsPage,
});

const SECURITY_OPTIONS: { value: SmtpSecurity; label: string }[] = [
  { value: "starttls", label: "STARTTLS" },
  { value: "tls", label: "TLS" },
  { value: "none", label: "None" },
];

function SmtpSettingsPage() {
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: settings } = useSuspenseQuery(smtpSettingsQuery);
  // A null settings response means "not an administrator", so this is only read on the
  // administrative branch below; keep it a plain boolean for the signed-out shape too.
  const emailVerified = session.signedIn && session.emailVerified;

  return (
    <main>
      <Text as="p" display="block" type="inherit" color="inherit">
        <Link to="/">Back to your workspaces</Link>
      </Text>
      <Heading level={1} color="inherit">
        SMTP settings
      </Heading>
      {settings === null ? (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          SMTP settings are available to system administrators only.
        </Text>
      ) : (
        <>
          <SmtpForm settings={settings} />
          <TestAndVerification configured={settings.host !== null} emailVerified={emailVerified} />
        </>
      )}
    </main>
  );
}

function SmtpForm({ settings }: { settings: SmtpSettingsResponse }) {
  const queryClient = useQueryClient();
  const [host, setHost] = useState(settings.host ?? "");
  const [port, setPort] = useState(settings.port);
  const [invalidPortEntry, setInvalidPortEntry] = useState(false);
  const [security, setSecurity] = useState<SmtpSecurity>(settings.security ?? "starttls");
  const [from, setFrom] = useState(settings.from ?? "");
  const [username, setUsername] = useState(settings.username ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalidPortEntry || port === null || port < 1 || port > 65535) {
      setStatus(undefined);
      setError("Enter a port between 1 and 65535.");
      return;
    }
    setSaving(true);
    setStatus(undefined);
    setError(undefined);
    try {
      const input: SmtpSettingsInput = {
        host,
        port,
        security,
        username: username === "" ? null : username,
        password: password === "" ? null : password,
        from,
      };
      const saved = await saveSmtpSettings(input);
      queryClient.setQueryData(smtpSettingsQuery.queryKey, saved);
      setPassword("");
      setStatus("SMTP settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the SMTP settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        SMTP configuration
      </Heading>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Host"
          id="smtp-host"
          htmlName="host"
          value={host}
          onChange={setHost}
          required
          maxLength={255}
        />

        <NumberInput
          label="Port"
          id="smtp-port"
          htmlName="port"
          value={port}
          onChange={setPort}
          onEntryErrorChange={(entry) => setInvalidPortEntry(entry !== null)}
          isIntegerOnly
          isRequired
        />

        <Selector
          label="Security"
          id="smtp-security"
          htmlName="security"
          value={security}
          onChange={(value) => {
            const parsed = SmtpSecurity.safeParse(value);
            if (parsed.success) setSecurity(parsed.data);
          }}
          options={SECURITY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        />

        <TextField
          label="From address"
          id="smtp-from"
          htmlName="from"
          type="email"
          value={from}
          onChange={setFrom}
          required
        />

        <TextField
          label="Username (optional)"
          id="smtp-username"
          htmlName="username"
          value={username}
          onChange={setUsername}
          maxLength={255}
        />

        <TextField
          label="Password (optional)"
          id="smtp-password"
          htmlName="password"
          type="password"
          value={password}
          onChange={setPassword}
          maxLength={1024}
          autoComplete="new-password"
        />
        {settings.hasPassword && (
          <Text as="p" display="block" type="inherit" color="inherit">
            A password is stored. Saving replaces the whole configuration, so re-enter it to keep
            it; leaving this field empty removes it.
          </Text>
        )}

        {status !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="status">
            {status}
          </Text>
        )}
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        <Button type="submit" isDisabled={saving} label="Save SMTP settings" variant="primary" />
      </form>
    </Section>
  );
}

function TestAndVerification({
  configured,
  emailVerified,
}: {
  configured: boolean;
  emailVerified: boolean;
}) {
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string>();
  const [sendError, setSendError] = useState<string>();
  const [token, setToken] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string>();

  async function onSend() {
    setSending(true);
    setSendStatus(undefined);
    setSendError(undefined);
    try {
      const result = await sendTestEmail();
      setSendStatus(`${result.message} Check ${result.sentTo} for the single-use token.`);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Could not send the test email.");
    } finally {
      setSending(false);
    }
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVerifying(true);
    setVerifyError(undefined);
    try {
      const account = await verifyEmail({ token });
      const session: Session = {
        signedIn: true,
        email: account.email,
        emailVerified: account.emailVerified,
      };
      queryClient.setQueryData(sessionQuery.queryKey, session);
      setToken("");
    } catch (cause) {
      setVerifyError(cause instanceof Error ? cause.message : "Could not verify the email.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Section className="page-section" padding={0}>
      <Heading level={2} color="inherit">
        Test email and verification
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        {emailVerified
          ? "Your email address is verified."
          : "Your email address is not verified yet."}
      </Text>
      <Button
        type="button"
        onClick={() => void onSend()}
        isDisabled={sending || !configured}
        label="Send test email"
        variant="secondary"
      />
      {!configured && (
        <Text as="p" display="block" type="inherit" color="inherit">
          Save your SMTP settings above before sending a test email.
        </Text>
      )}
      {sendStatus !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="status">
          {sendStatus}
        </Text>
      )}
      {sendError !== undefined && (
        <Text as="p" display="block" type="inherit" color="inherit" role="alert">
          {sendError}
        </Text>
      )}
      {!emailVerified && (
        <form onSubmit={(event) => void onVerify(event)}>
          <TextField
            label="Verification token from the test email"
            id="verify-token"
            htmlName="token"
            value={token}
            onChange={setToken}
            required
            autoComplete="off"
          />
          {verifyError !== undefined && (
            <Text as="p" display="block" type="inherit" color="inherit" role="alert">
              {verifyError}
            </Text>
          )}
          <Button type="submit" isDisabled={verifying} label="Verify email" variant="primary" />
        </form>
      )}
    </Section>
  );
}
