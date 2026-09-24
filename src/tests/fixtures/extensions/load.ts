import {
  type ExtensionCatalogEntry,
  setExtensionCatalogForTests,
} from "../../../extensions/catalog";
import type { ExtensionManifest } from "../../../types";

export type BundleFixture = { manifest: ExtensionManifest; files: Record<string, string> };

/** Read `fixtures/extensions/<name>/`: its manifest plus every file the manifest references. */
export async function loadBundleFixture(name: string): Promise<BundleFixture> {
  const directory = new URL(`./${name}/`, import.meta.url);
  const manifest = (await Bun.file(
    new URL("manifest.json", directory),
  ).json()) as ExtensionManifest;
  const paths = [
    manifest.assets.hooks,
    ...(Array.isArray(manifest.assets.scripts)
      ? manifest.assets.scripts.map((script) => script.file)
      : []),
  ];
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = await Bun.file(new URL(path, directory)).text();
  return { manifest, files };
}

export function catalogEntry(bundle: BundleFixture): ExtensionCatalogEntry {
  return {
    manifestFile: "manifest.json",
    manifest: bundle.manifest,
    files: bundle.files,
    readme: null,
  };
}

/**
 * Register fixtures as the extension catalog (install accepts only catalog names).
 * Pass fixture directory names, or bundles keyed by the template name to install them under.
 */
export async function useFixtureCatalog(
  fixtures: string[] | Record<string, BundleFixture>,
): Promise<void> {
  const bundles = Array.isArray(fixtures)
    ? Object.fromEntries(
        await Promise.all(
          fixtures.map(async (name) => [name, await loadBundleFixture(name)] as const),
        ),
      )
    : fixtures;
  setExtensionCatalogForTests(
    Object.fromEntries(
      Object.entries(bundles).map(([name, bundle]) => [name, catalogEntry(bundle)]),
    ),
  );
}

export function resetFixtureCatalog(): void {
  setExtensionCatalogForTests(null);
}
