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
 * cleanly.
 *
 * Usage:  bun run build:seed-skill-files
 *         bun run check:seed-skill-files    # CI drift check, no write
 */

import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates", "skills");
const OUT_PATH = join(REPO_ROOT, "src", "be", "seed-skills", "bundled-files.generated.json");

type BundledFile = { path: string; content: string };

/** Collect `<skillDir>/files/**` as skill-relative bundled files. */
async function collectFiles(filesRoot: string): Promise<BundledFile[]> {
  const collected: BundledFile[] = [];

  for await (const relative of new Bun.Glob("**/*").scan({ cwd: filesRoot, onlyFiles: true })) {
    // Bun.Glob yields platform-native separators; skill_files paths are POSIX.
    const path = relative.split("\\").join("/");
    collected.push({ path, content: await Bun.file(join(filesRoot, relative)).text() });
  }

  return collected.sort((a, b) => a.path.localeCompare(b.path));
}

async function build(): Promise<string> {
  const manifest: Record<string, BundledFile[]> = {};

  // Every skill directory that ships a config; `files/` is optional.
  for await (const configRelative of new Bun.Glob("*/config.json").scan({ cwd: TEMPLATES_DIR })) {
    const skillDir = join(TEMPLATES_DIR, configRelative, "..");
    const filesRoot = join(skillDir, "files");

    // `files/` is optional — a scan over a missing directory yields nothing on
    // some platforms and throws on others, so treat both as "no bundled files".
    const files = await collectFiles(filesRoot).catch(() => [] as BundledFile[]);
    if (files.length === 0) continue;

    // Key by the config's declared name, which is what the seeder looks up.
    const config = (await Bun.file(join(TEMPLATES_DIR, configRelative)).json()) as {
      name?: string;
    };
    const name = config.name ?? configRelative.split("/")[0];
    if (name) manifest[name] = files;
  }

  // Stable key order so the generated file is byte-reproducible.
  const ordered: Record<string, BundledFile[]> = {};
  for (const key of Object.keys(manifest).sort()) {
    ordered[key] = manifest[key] as BundledFile[];
  }

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const generated = await build();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const out = Bun.file(OUT_PATH);
  const current = (await out.exists()) ? await out.text() : "";
  if (current !== generated) {
    console.error(
      "[build-seed-skill-files] bundled-files.generated.json is stale.\n" +
        "Run `bun run build:seed-skill-files` and commit the result.",
    );
    process.exit(1);
  }
  console.log("[build-seed-skill-files] up to date");
} else {
  await Bun.write(OUT_PATH, generated);
  const skillCount = Object.keys(JSON.parse(generated)).length;
  console.log(`[build-seed-skill-files] wrote ${skillCount} skill(s) to ${OUT_PATH}`);
}
