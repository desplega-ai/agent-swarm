/**
 * Generate the predefined extension catalog.
 *
 * Source of truth: `templates/extensions/<name>/` (one `manifest.{yaml,yml,json}`
 *                  plus every file it references and an optional README.md)
 * Output:          `src/extensions/catalog.generated.json`
 *
 * The API runs from a compiled binary without `templates/`, so the catalog is
 * embedded as one JSON import (same reason as `build-seed-skill-files.ts`).
 * YAML is parsed here, so the API never parses YAML at runtime.
 *
 * Usage:  bun run build:extension-catalog
 *         bun run check:extension-catalog    # CI drift check, no write
 */

import { join } from "node:path";
import { buildExtensionCatalog } from "../src/extensions/catalog-build";

const REPO_ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates", "extensions");
const OUT_PATH = join(REPO_ROOT, "src", "extensions", "catalog.generated.json");

let generated: string;
try {
  generated = `${JSON.stringify(await buildExtensionCatalog(TEMPLATES_DIR), null, 2)}\n`;
} catch (error) {
  console.error(
    `[build-extension-catalog] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (process.argv.includes("--check")) {
  const out = Bun.file(OUT_PATH);
  const current = (await out.exists()) ? await out.text() : "";
  if (current !== generated) {
    console.error(
      "[build-extension-catalog] catalog.generated.json is stale.\n" +
        "Run `bun run build:extension-catalog` and commit the result.",
    );
    process.exit(1);
  }
  console.log("[build-extension-catalog] up to date");
} else {
  await Bun.write(OUT_PATH, generated);
  console.log(
    `[build-extension-catalog] wrote ${Object.keys(JSON.parse(generated)).length} extension(s) to ${OUT_PATH}`,
  );
}
