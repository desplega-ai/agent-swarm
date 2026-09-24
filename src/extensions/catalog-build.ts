/**
 * Build-time reader for the predefined extension catalog (`templates/extensions/`).
 * Used by `scripts/build-extension-catalog.ts` and tests only; the API reads the
 * generated `catalog.generated.json` because the compiled binary has no `templates/`.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCatalogEntry } from "./catalog";
import { MANIFEST_FILENAMES, parseManifestText, referencedBundlePaths } from "./manifest-format";

/** Read every `<templatesDir>/<name>/` into a catalog entry. Throws on the first invalid template. */
export async function buildExtensionCatalog(
  templatesDir: string,
): Promise<Record<string, ExtensionCatalogEntry>> {
  const entries = await readdir(templatesDir, { withFileTypes: true });
  const catalog: Record<string, ExtensionCatalogEntry> = {};
  for (const directory of entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const root = join(templatesDir, directory);
    const present = (await readdir(root))
      .sort()
      .filter((file) => (MANIFEST_FILENAMES as readonly string[]).includes(file));
    if (present.length !== 1) {
      throw new Error(
        `templates/extensions/${directory}: expected exactly one of ${MANIFEST_FILENAMES.join(", ")}, found ${present.length === 0 ? "none" : present.join(", ")}`,
      );
    }
    const manifestFile = present[0] as string;
    const manifest = parseManifestText(
      `${directory}/${manifestFile}`,
      await Bun.file(join(root, manifestFile)).text(),
    );
    if (manifest.name !== directory) {
      throw new Error(
        `templates/extensions/${directory}: manifest name "${manifest.name}" must equal the directory name`,
      );
    }
    const files: Record<string, string> = {};
    for (const path of referencedBundlePaths(manifest)) {
      const file = Bun.file(join(root, path));
      if (!(await file.exists())) {
        throw new Error(
          `templates/extensions/${directory}: referenced file "${path}" does not exist`,
        );
      }
      files[path] = await file.text();
    }
    const readme = Bun.file(join(root, "README.md"));
    catalog[manifest.name] = {
      manifestFile,
      manifest,
      files,
      readme: (await readme.exists()) ? await readme.text() : null,
    };
  }
  return catalog;
}
