import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the server runs on :8080 and Vite proxies API, MCP and health requests to it.
const server = "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": server, "/mcp": server, "/healthz": server, "/readyz": server },
  },
});
