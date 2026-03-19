import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5274,
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET || "http://localhost:3013",
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      "/health": {
        target: process.env.VITE_PROXY_TARGET || "http://localhost:3013",
        changeOrigin: true,
      },
    },
  },
});
