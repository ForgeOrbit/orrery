import { z } from "zod";
import { Email, NewPassword } from "./common.ts";



export const SetupStatus = z
  .object({
    setupComplete: z.boolean(),
  })
  .meta({ id: "SetupStatus" });
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupAdminRequest = z
  .object({
    secret: z.string().min(1),
    email: Email,
    password: NewPassword,
  })
  .meta({ id: "SetupAdminRequest" });
export type SetupAdminRequest = z.infer<typeof SetupAdminRequest>;


export const SetupAdminResponse = z
  .object({
    email: Email,
  })
  .meta({ id: "SetupAdminResponse" });
export type SetupAdminResponse = z.infer<typeof SetupAdminResponse>;
