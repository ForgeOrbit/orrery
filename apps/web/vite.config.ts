import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the server runs on :8080 and Vite proxies API, MCP and health requests to it.
const server = "http://localhost:8080";

export default defineConfig({
  // The router plugin must come before React: it generates src/routeTree.gen.ts from src/routes/
  // and splits each route into its own chunk.
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  server: {
    port: 5173,
    proxy: { "/api": server, "/mcp": server, "/healthz": server, "/readyz": server },
  },
});
