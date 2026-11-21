import { z } from "zod";
import { Email, Timestamp } from "./common.ts";





export const AccountStatus = z
  .object({
    humanId: z.string(),
    email: Email,
    deactivatedAt: Timestamp.nullable(),
    isSystemAdministrator: z.boolean(),
  })
  .meta({ id: "AccountStatus" });
export type AccountStatus = z.infer<typeof AccountStatus>;
