import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
      <p>
        <Link to="/">Back to your workspaces</Link>
      </p>
      <h1>SMTP settings</h1>
      {settings === null ? (
        <p role="alert">SMTP settings are available to system administrators only.</p>
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
  const [port, setPort] = useState(settings.port?.toString() ?? "");
  const [security, setSecurity] = useState<SmtpSecurity>(settings.security ?? "starttls");
  const [from, setFrom] = useState(settings.from ?? "");
  const [username, setUsername] = useState(settings.username ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setStatus(undefined);
    setError(undefined);
    try {
      const input: SmtpSettingsInput = {
        host,
        port: Number(port),
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
    <section>
      <h2>SMTP configuration</h2>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label htmlFor="smtp-host">Host</label>
        <input
          id="smtp-host"
          name="host"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          required
          maxLength={255}
        />

        <label htmlFor="smtp-port">Port</label>
        <input
          id="smtp-port"
          name="port"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(event) => setPort(event.target.value)}
          required
        />

        <label htmlFor="smtp-security">Security</label>
        <select
          id="smtp-security"
          name="security"
          value={security}
          onChange={(event) => {
            const parsed = SmtpSecurity.safeParse(event.target.value);
            if (parsed.success) setSecurity(parsed.data);
          }}
        >
          {SECURITY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor="smtp-from">From address</label>
        <input
          id="smtp-from"
          name="from"
          type="email"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          required
        />

        <label htmlFor="smtp-username">Username (optional)</label>
        <input
          id="smtp-username"
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          maxLength={255}
        />

        <label htmlFor="smtp-password">Password (optional)</label>
        <input
          id="smtp-password"
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          maxLength={1024}
          autoComplete="new-password"
        />
        {settings.hasPassword && (
          <p>
            A password is stored. Saving replaces the whole configuration, so re-enter it to keep
            it; leaving this field empty removes it.
          </p>
        )}

        {status !== undefined && <p role="status">{status}</p>}
        {error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" disabled={saving}>
          Save SMTP settings
        </button>
      </form>
    </section>
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
    <section>
      <h2>Test email and verification</h2>
      <p>
        {emailVerified
          ? "Your email address is verified."
          : "Your email address is not verified yet."}
      </p>
      <button type="button" onClick={() => void onSend()} disabled={sending || !configured}>
        Send test email
      </button>
      {!configured && <p>Save your SMTP settings above before sending a test email.</p>}
      {sendStatus !== undefined && <p role="status">{sendStatus}</p>}
      {sendError !== undefined && <p role="alert">{sendError}</p>}
      {!emailVerified && (
        <form onSubmit={(event) => void onVerify(event)}>
          <label htmlFor="verify-token">Verification token from the test email</label>
          <input
            id="verify-token"
            name="token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
            autoComplete="off"
          />
          {verifyError !== undefined && <p role="alert">{verifyError}</p>}
          <button type="submit" disabled={verifying}>
            Verify email
          </button>
        </form>
      )}
    </section>
  );
}
