import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { sharedAlias, sharedDefine } from "./vite.config";

/**
 * The `<swarm-object>` bundle for pages (`src/embed/swarm-object.tsx`). It runs
 * after the dashboard build and writes into the same `dist/`, under
 * `embed/v1/`, so nginx and Vercel serve it from the dashboard origin.
 *
 * A separate build, not a second input of the dashboard build: the page loads
 * it cross-origin, so its chunks must resolve relative to the script (`base:
 * "./"`), and its CSS must be one file the element links inside its shadow root
 * (`cssCodeSplit: false`), never `<link>`s Vite adds to the page's `<head>`.
 */
const OUT = "embed/v1";
const STYLESHEET = `${OUT}/swarm-object.css`;
const GLOBAL_STYLESHEET = `${OUT}/swarm-object-global.css`;

/** `@property` and `@font-face` rules: browsers ignore both inside a shadow root. */
const DOCUMENT_ONLY_RULE = /@(?:property|font-face)\b[^{]*\{[^{}]*\}/g;

/**
 * Splits the bundled CSS in two. The shadow-root sheet gets every rule, with
 * `:root` (which matches nothing in a shadow tree) rewritten to `:host`. The
 * global sheet gets only the rules that work at document level alone, such as
 * Tailwind's `@property --tw-*` initial values (without them `border`, `ring`
 * and `shadow` utilities compute to nothing). The element links it once.
 */
function shadowRootStyles(): Plugin {
  return {
    name: "swarm-object-shadow-styles",
    apply: "build",
    // writeBundle, not generateBundle: Vite emits the single CSS file in its own late hook.
    writeBundle(options) {
      if (!options.dir) return;
      const sheet = path.join(options.dir, STYLESHEET);
      if (!fs.existsSync(sheet)) this.error(`expected one CSS asset at ${STYLESHEET}`);
      const css = fs.readFileSync(sheet, "utf8");
      const documentRules = css.match(DOCUMENT_ONLY_RULE) ?? [];
      fs.writeFileSync(sheet, css.replace(DOCUMENT_ONLY_RULE, "").replace(/:root\b/g, ":host"));
      fs.writeFileSync(path.join(options.dir, GLOBAL_STYLESHEET), documentRules.join(""));
    },
  };
}

/**
 * Self-hosts Excalidraw's fonts at `embed/v1/fonts/` (its `EXCALIDRAW_ASSET_PATH`),
 * so boards on pages and in the dashboard do not load them from esm.sh.
 */
function excalidrawFonts(): Plugin {
  return {
    name: "swarm-object-excalidraw-fonts",
    apply: "build",
    writeBundle(options) {
      if (!options.dir) return;
      const entry = createRequire(import.meta.url).resolve("@excalidraw/excalidraw");
      const fonts = path.join(path.dirname(entry), "fonts");
      fs.cpSync(fonts, path.join(options.dir, OUT, "fonts"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), shadowRootStyles(), excalidrawFonts()],
  define: sharedDefine,
  resolve: { alias: sharedAlias },
  base: "./",
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: { "swarm-object": path.resolve(__dirname, "src/embed/swarm-object.tsx") },
      output: {
        entryFileNames: `${OUT}/[name].js`,
        chunkFileNames: `${OUT}/chunks/[name]-[hash].js`,
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css"))
            ? STYLESHEET
            : `${OUT}/chunks/[name]-[hash][extname]`,
      },
    },
  },
});
