---
status: accepted
---

# Bootstrap the first administrator before configuring email

Orrery needs a system administrator before SMTP is available. Human login uses email and password for the MVP, with a separate bootstrap flow for the first administrator.

The installer supplies a one-time setup secret through deployment configuration. Initial setup requires that secret before creating the first system administrator with an email and password. Creating the account also creates its personal workspace and persists completion of bootstrap, so restarting the server cannot reopen initial setup.

The first administrator can sign in before verifying their email, configure SMTP, and send a test email. They then verify mailbox ownership. Successful bootstrap establishes installation authority, not verified email ownership. An SMTP failure must allow the administrator to sign in and repair email settings.

Until that email is verified, recovery uses the local command. Password resets are never emailed to an unverified address.

Deployment essentials, including the database connection and bootstrap secret, use environment variables. System administrators manage persistent instance settings, including SMTP, through the app. This replaces the earlier environment-variables-only policy, so self-hosters can configure email after creating the administrator.

The system administrator role is distinct from workspace ownership. [ADR-0002](0002-personal-and-shared-workspaces.md) defines the workspaces an installation supports.

This records the agreed design for [M0](https://github.com/forge-orbit/orrery/issues/1) and [M1](https://github.com/forge-orbit/orrery/issues/2). Bootstrap, authentication, and SMTP settings still need implementation.
