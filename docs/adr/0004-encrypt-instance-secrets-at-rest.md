---
status: accepted
---

# Encrypt instance secrets at rest

ADR-0001 keeps persistent instance settings, including SMTP, in the database so an administrator can repair them through the app. The SMTP password is a working credential for an upstream relay: stored in the clear, it would sit in the database and in every backup of it, so anyone with a dump could send mail as the installation.

The deployment supplies a 32-byte key in `ORRERY_ENCRYPTION_KEY` (base64; generate with `openssl rand -base64 32`). Orrery encrypts the password with AES-256-GCM and stores a versioned ciphertext, `v1:<iv>:<tag>:<ct>` in base64url, in `instance_settings.smtp_password_encrypted`; it decrypts only to send one message. The key is deployment configuration, like the database URL; the ciphertext is instance data, like the rest of the settings. Without a key, a password cannot be saved (409 `encryption_key_missing`), and a stored password no key can read — the key changed or was removed — answers `smtp_password_unreadable`, telling the administrator to re-enter it; nothing crashes, and startup warns when a stored password has no key. The key, the plaintext, and the ciphertext never reach a log or a response.

Plaintext at rest was rejected: backups and database dumps would leak a usable password. Keeping the password only in an environment variable was rejected too: the administrator could not repair or inspect the settings through the app, which ADR-0001 promises. A key in the environment is the compromise: one deployment secret unlocks instance data without turning the data itself into deployment configuration.

This records the design for issue #22. Any later secret the app must be able to read back (a hash would not do) uses the same key and the same versioned format.
