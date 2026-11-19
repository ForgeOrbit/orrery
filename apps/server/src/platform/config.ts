import { z } from "zod";

// All configuration comes from environment variables, so the same names work for any
// implementation of the server (see the runtime contract in AGENTS.md).
const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.url(),
  // The URL people and agents use to reach this server. Its host is the only Host header MCP accepts.
  PUBLIC_URL: z.url().default("http://localhost:8080"),
  // The one-time secret that protects initial setup (issue #21). An unset or empty value
  // means no secret is configured, and setup cannot create the administrator. A
  // configured secret must be strong enough to be worth protecting setup with.
  BOOTSTRAP_SECRET: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim() === "" ? undefined : value))
    .refine((value) => value === undefined || value.length >= 32, {
      message: "BOOTSTRAP_SECRET must be at least 32 characters. Generate a long random secret.",
    }),
  // The 32-byte key (base64) that encrypts instance secrets at rest (ADR-0004), the
  // SMTP password first. An unset or empty value means no key: a password cannot be
  // saved until the deployment supplies one. Generate with: openssl rand -base64 32.
  ORRERY_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((value) => (value !== undefined && value.trim() === "" ? undefined : value))
    .transform((value) => (value === undefined ? undefined : Buffer.from(value, "base64")))
    .refine((value) => value === undefined || value.byteLength === 32, {
      message:
        "ORRERY_ENCRYPTION_KEY must be base64 for exactly 32 bytes. Generate one with: openssl rand -base64 32",
    }),
  // Directory with the built web app. Unset in development, where Vite serves it.
  WEB_DIST: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
