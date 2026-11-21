import { RecoveryMessage } from "@orrery/contract";
import type { ConfirmPasswordReset, RequestPasswordReset } from "@orrery/contract";
import { postJson } from "../../lib/api.ts";

export function requestPasswordReset(input: RequestPasswordReset): Promise<RecoveryMessage> {
  return postJson("/api/auth/password-reset/request", input, (value) =>
    RecoveryMessage.parse(value),
  );
}

export function confirmPasswordReset(input: ConfirmPasswordReset): Promise<RecoveryMessage> {
  return postJson("/api/auth/password-reset/confirm", input, (value) =>
    RecoveryMessage.parse(value),
  );
}
