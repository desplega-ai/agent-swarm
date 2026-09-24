/**
 * The predefined extension catalog: every bundle under `templates/extensions/`,
 * embedded at build time as `catalog.generated.json` (regenerate with
 * `bun run build:extension-catalog`). Install accepts only names from here.
 */
import type { ExtensionManifest } from "../types";
import generated from "./catalog.generated.json";

export type ExtensionCatalogEntry = {
  /** The manifest file name in the template directory (`manifest.yaml`, `manifest.yml` or `manifest.json`). */
  manifestFile: string;
  manifest: ExtensionManifest;
  /** Every bundle file the manifest references, keyed by bundle path. */
  files: Record<string, string>;
  readme: string | null;
};

const BUNDLED = generated as unknown as Record<string, ExtensionCatalogEntry>;
let override: Record<string, ExtensionCatalogEntry> | null = null;

export function getExtensionCatalog(): Record<string, ExtensionCatalogEntry> {
  return override ?? BUNDLED;
}

export function getCatalogEntry(name: string): ExtensionCatalogEntry | null {
  const catalog = getExtensionCatalog();
  return Object.hasOwn(catalog, name) ? (catalog[name] ?? null) : null;
}

/**
 * Test seam: replace the catalog with fixture entries (`null` restores the bundled catalog).
 * There is no runtime equivalent; production installs only what was bundled at build time.
 */
export function setExtensionCatalogForTests(
  entries: Record<string, ExtensionCatalogEntry> | null,
): void {
  override = entries;
}
