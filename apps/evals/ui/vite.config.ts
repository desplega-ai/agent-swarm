import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    // benchmark.html is the public /benchmark page, bundled on its own (Phase 10).
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        benchmark: resolve(import.meta.dirname, "benchmark.html"),
      },
    },
  },
  server: { proxy: { "/api": "http://localhost:4801" } },
});
