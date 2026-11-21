import { z } from "zod";
import { Email, NewPassword } from "./common.ts";





export const RequestPasswordReset = z
  .object({ email: Email })
  .meta({ id: "RequestPasswordReset" });
export type RequestPasswordReset = z.infer<typeof RequestPasswordReset>;



export const ConfirmPasswordReset = z
  .object({
    token: z.string().min(1).max(256),
    password: NewPassword,
  })
  .meta({ id: "ConfirmPasswordReset" });
export type ConfirmPasswordReset = z.infer<typeof ConfirmPasswordReset>;



export const RecoveryMessage = z
  .object({ message: z.string() })
  .meta({ id: "RecoveryMessage" });
export type RecoveryMessage = z.infer<typeof RecoveryMessage>;
