import { z } from "zod";

// All configuration comes from environment variables, so the same names work for any
// implementation of the server (see the runtime contract in AGENTS.md).
const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.url(),
  // The URL people and agents use to reach this server. Its host is the only Host header MCP accepts.
  PUBLIC_URL: z.url().default("http://localhost:8080"),
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
