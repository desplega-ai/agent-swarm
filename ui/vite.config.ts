import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as {
  version?: string;
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version ?? "0.0.0"),
  },
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
      "/status": {
        target: process.env.VITE_PROXY_TARGET || "http://localhost:3013",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("monaco-editor") || id.includes("@monaco-editor")) return "vendor-monaco";
          if (id.includes("ag-grid-community") || id.includes("ag-grid-react")) {
            return "vendor-ag-grid";
          }
          if (id.includes("recharts")) return "vendor-recharts";
          if (id.includes("@xyflow/react")) return "vendor-xyflow";
          return undefined;
        },
      },
    },
  },
});
