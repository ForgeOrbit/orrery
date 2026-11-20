// Local administrator recovery (issue #31, story 10). Run inside the container, against
// the same database the server uses:
//
//   docker compose exec -T \
//     -e ORRERY_RECOVERY_EMAIL=someone@example.com \
//     -e ORRERY_RECOVERY_PASSWORD=a-new-password \
//     orrery node apps/server/src/recovery-cli.ts
//
// The authority is access to the server itself, like psql: SMTP may be broken or never
// configured, and no public bypass or reset token is involved. The command uses the
// recovery service's localRecover(), so it enforces exactly the same credential policy
// as the HTTP flow and can only change a password, end browser sessions, and write one
// secret-free event. It never touches bootstrap or workspace ownership.

import { Email, NewPassword } from "@orrery/contract";
import {
  accountByEmail,
  invalidateAccountSessions,
  setAccountPassword,
} from "./features/accounts/index.ts";
import { createRecoveryService, RecoveryError } from "./features/recovery/index.ts";
import { loadConfig } from "./platform/config.ts";
import { createDb } from "./platform/db.ts";
import { errorSummary } from "./platform/errors.ts";
import { createLogger } from "./platform/log.ts";

const usage =
  "Usage: set ORRERY_RECOVERY_EMAIL and ORRERY_RECOVERY_PASSWORD, then run " +
  "node apps/server/src/recovery-cli.ts with the server's environment.";

const emailInput = process.env.ORRERY_RECOVERY_EMAIL;
const passwordInput = process.env.ORRERY_RECOVERY_PASSWORD;
if (emailInput === undefined || passwordInput === undefined) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const email = Email.safeParse(emailInput);
const password = NewPassword.safeParse(passwordInput);
if (!email.success || !password.success) {
  // Never echo the value: an invalid password is still a secret.
  process.stderr.write("The recovery email or password is invalid.\n");
  process.exit(2);
}

const config = loadConfig();
const database = createDb(config.DATABASE_URL);
const log = createLogger(config.LOG_LEVEL);
const recovery = createRecoveryService({
  db: database.db,
  accounts: {
    accountByEmail: (address, tx) => accountByEmail(tx ?? database.db, address),
    setPassword: (humanId, newPassword, tx) => setAccountPassword(tx, humanId, newPassword),
    invalidateBrowserSessions: (humanId, tx) => invalidateAccountSessions(tx, humanId),
  },
  // localRecover() never sends mail. A sender that refuses makes any accidental use
  // of the mail path fail loudly instead of silently depending on a broken relay.
  deliver: async () => {
    throw new Error("local recovery never sends mail");
  },
  publicUrl: config.PUBLIC_URL,
  log,
});

try {
  const result = await recovery.localRecover(email.data, password.data);
  // The address is not a secret; the new password is never printed or logged.
  process.stdout.write(`Password recovered for ${result.email}.\n`);
} catch (error) {
  log.error("local recovery failed", { ...errorSummary(error) });
  process.stderr.write(
    error instanceof RecoveryError ? `${error.message}\n` : "Local recovery failed.\n",
  );
  process.exitCode = 1;
} finally {
  await database.sql.end();
}
