import { z } from "zod";

// Field schemas shared by setup and authentication. Email keeps one normalization
// for the whole installation: trim, then lowercase, with no provider rewriting.
export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email()).meta({ id: "Email" });
export type Email = z.infer<typeof Email>;

export const Password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(256)
  .meta({ id: "Password" });
export type Password = z.infer<typeof Password>;

// Every error response, in every transport, is a Problem: a short, human-readable
// message and nothing else, so internals (and secrets) never leak into responses.
export const Problem = z.object({ message: z.string() }).meta({ id: "Problem" });
export type Problem = z.infer<typeof Problem>;
