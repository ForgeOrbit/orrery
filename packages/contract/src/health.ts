import { z } from "zod";

export const Health = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
  })
  .meta({ id: "Health" });

export type Health = z.infer<typeof Health>;
