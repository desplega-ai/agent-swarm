/**
 * Generate the bundled-file manifest for seeded skills.
 *
 * Source of truth: `templates/skills/<name>/files/**`
 * Output:          `src/be/seed-skills/bundled-files.generated.json`
 *
 * Why a generated manifest instead of per-file `import ... with { type: "text" }`?
 *
 *   1. The API runs from a `bun build --compile` binary and `templates/` only
 *      exists in the Dockerfile's builder stage, so the seeder cannot read the
 *      directory at runtime — content must be embedded at compile time.
 *   2. TypeScript resolves `.ts` imports as modules and types `.html` imports as
 *      `HTMLBundle`, so a text-import per bundled file does not typecheck.
 *
 * One `.json` import sidesteps both: JSON is embedded at build time and types
 * cleanly as a string.
 *
 * Usage:  bun run build:seed-skill-files
 *         bun run build:seed-skill-files --check    # CI drift check, no write
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates", "skills");
const OUT_PATH = join(REPO_ROOT, "src", "be", "seed-skills", "bundled-files.generated.json");

type BundledFile = { path: string; content: string };

function collectFiles(filesRoot: string): BundledFile[] {
  const collected: BundledFile[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      collected.push({ path: rel, content: readFileSync(full, "utf-8") });
    }
  };
  walk(filesRoot, "");

  return collected.sort((a, b) => a.path.localeCompare(b.path));
}

function build(): string {
  const manifest: Record<string, BundledFile[]> = {};

  for (const entry of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(TEMPLATES_DIR, entry.name);
    const filesRoot = join(skillDir, "files");
    if (!existsSync(filesRoot)) continue;

    // Key by the config's declared name, which is what the seeder looks up.
    const configPath = join(skillDir, "config.json");
    if (!existsSync(configPath)) continue;
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as { name?: string };
    const name = config.name ?? entry.name;

    const files = collectFiles(filesRoot);
    if (files.length > 0) manifest[name] = files;
  }

  // Stable key order so the generated file is byte-reproducible.
  const ordered: Record<string, BundledFile[]> = {};
  for (const key of Object.keys(manifest).sort()) {
    ordered[key] = manifest[key] as BundledFile[];
  }

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const generated = build();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf-8") : "";
  if (current !== generated) {
    console.error(
      "[build-seed-skill-files] bundled-files.generated.json is stale.\n" +
        "Run `bun run build:seed-skill-files` and commit the result.",
    );
    process.exit(1);
  }
  console.log("[build-seed-skill-files] up to date");
} else {
  writeFileSync(OUT_PATH, generated);
  const skillCount = Object.keys(JSON.parse(generated)).length;
  console.log(`[build-seed-skill-files] wrote ${skillCount} skill(s) to ${OUT_PATH}`);
}
