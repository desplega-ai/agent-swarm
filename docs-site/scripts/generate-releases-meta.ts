/**
 * Generates the releases/meta.json with pages ordered newest-first.
 * Run: bun scripts/generate-releases-meta.ts
 *
 * Scans content/docs/(documentation)/releases/ for MDX files,
 * orders them by filename (YYYY-MM-DD) descending, and writes meta.json.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const releasesDir = resolve(
  __dirname,
  "../content/docs/(documentation)/releases",
);

const mdxFiles = readdirSync(releasesDir)
  .filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
  .map((f) => f.replace(/\.mdx$/, ""))
  .sort()
  .reverse();

const meta = {
  title: "Releases",
  pages: ["index", ...mdxFiles],
};

writeFileSync(
  resolve(releasesDir, "meta.json"),
  `${JSON.stringify(meta, null, 2)}\n`,
);

console.log(
  `Generated releases meta.json: ${mdxFiles.length} release${mdxFiles.length !== 1 ? "s" : ""} (newest: ${mdxFiles[0] ?? "none"})`,
);
