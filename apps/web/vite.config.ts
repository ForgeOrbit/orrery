import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = "http://localhost:8080";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  server: {
    port: 5173,
    proxy: { "/api": server, "/mcp": server, "/healthz": server, "/readyz": server },
  },
});
