import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { createLogger } from "./log.ts";
import { createSystemService } from "./service/system.ts";
import { version } from "./version.ts";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const { sql } = createDb(config.DATABASE_URL);

const migrationsDir = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const applied = await migrate(sql, migrationsDir);
if (applied.length > 0) log.info("migrations applied", { applied });

const app = createApp({
  services: { system: createSystemService(sql) },
  publicUrl: config.PUBLIC_URL,
  webDist: config.WEB_DIST,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log.info("orrery listening", { port: info.port, version, publicUrl: config.PUBLIC_URL });
});

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
