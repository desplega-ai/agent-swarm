import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
) as {
  version?: string;
};

/** Plausible site script id of the hosted dashboard (app.agent-swarm.dev). */
const DEFAULT_PLAUSIBLE_SCRIPT_ID = "aDF5FACknjhykIUMd6n_a";

/**
 * Plausible analytics, injected into index.html at build time only when
 * `VITE_PLAUSIBLE_ANALYTICS=1` (or `true`) is set. Our Vercel production
 * project sets it; self-hosted and local builds ship with no analytics script.
 * `VITE_PLAUSIBLE_SCRIPT_ID` picks the Plausible site (the `pa-<id>.js` part
 * of the snippet) so a second deployment, such as the public demo, reports to
 * its own site instead of the hosted dashboard's.
 */
function plausibleAnalytics(): Plugin {
  const flag = (process.env.VITE_PLAUSIBLE_ANALYTICS ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  const scriptId =
    (process.env.VITE_PLAUSIBLE_SCRIPT_ID ?? "").trim() || DEFAULT_PLAUSIBLE_SCRIPT_ID;
  return {
    name: "plausible-analytics",
    transformIndexHtml() {
      if (!enabled) return [];
      return [
        {
          tag: "script",
          attrs: { async: true, src: `https://plausible.io/js/pa-${scriptId}.js` },
          injectTo: "head",
        },
        {
          tag: "script",
          children:
            "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()",
          injectTo: "head",
        },
      ];
    },
  };
}

const allowedHosts =
  process.env.VITE_ALLOWED_HOSTS === "*"
    ? true
    : process.env.VITE_ALLOWED_HOSTS?.split(",").map((host) => host.trim());

export default defineConfig({
  plugins: [react(), tailwindcss(), plausibleAnalytics()],
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
    allowedHosts,
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
