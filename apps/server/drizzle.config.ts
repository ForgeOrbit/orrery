import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Create src/db/schema.ts with the first table (see #8); drizzle-kit writes SQL to /db/migrations.
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "../../db/migrations",
});
