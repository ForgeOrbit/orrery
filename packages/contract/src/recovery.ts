import { z } from "zod";
import { Email, NewPassword } from "./common.ts";

// Password recovery (issue #31). Asking for a reset never reveals whether the address
// has an account or whether its mailbox is verified (#20): every request answers the
// same resource, and only an eligible address receives mail.

export const RequestPasswordReset = z
  .object({ email: Email })
  .meta({ id: "RequestPasswordReset" });
export type RequestPasswordReset = z.infer<typeof RequestPasswordReset>;

// The token travels in the emailed link; opening the link changes nothing. The new
// password is supplied by this POST, which is the only thing that redeems the token.
export const ConfirmPasswordReset = z
  .object({
    token: z.string().min(1).max(256),
    password: NewPassword,
  })
  .meta({ id: "ConfirmPasswordReset" });
export type ConfirmPasswordReset = z.infer<typeof ConfirmPasswordReset>;

// Both recovery endpoints answer with the same kind of message: no account, email, or
// verification state is ever disclosed by a recovery response.
export const RecoveryMessage = z
  .object({ message: z.string() })
  .meta({ id: "RecoveryMessage" });
export type RecoveryMessage = z.infer<typeof RecoveryMessage>;
