import { z } from "zod";
import { Email, Timestamp } from "./common.ts";

// Account deactivation and reactivation (#38). A system administrator suspends a human
// account across the installation without deleting anything. These schemas are the bare
// resource an admin route returns after the change; there is no request body because the
// target is named in the path and the actor comes from the session.
export const AccountStatus = z
  .object({
    humanId: z.string(),
    email: Email,
    deactivatedAt: Timestamp.nullable(),
    isSystemAdministrator: z.boolean(),
  })
  .meta({ id: "AccountStatus" });
export type AccountStatus = z.infer<typeof AccountStatus>;
