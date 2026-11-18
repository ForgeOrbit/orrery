import { z } from "zod";
import { Email, Password } from "./common.ts";

// Initial setup: creating the first system administrator (issue #21). Bootstrap is
// protected by a deployment-supplied secret and closes exactly once, permanently.
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
    password: Password,
  })
  .meta({ id: "SetupAdminRequest" });
export type SetupAdminRequest = z.infer<typeof SetupAdminRequest>;

// The administrator's email, as stored. The response never includes the password.
export const SetupAdminResponse = z
  .object({
    email: Email,
  })
  .meta({ id: "SetupAdminResponse" });
export type SetupAdminResponse = z.infer<typeof SetupAdminResponse>;
