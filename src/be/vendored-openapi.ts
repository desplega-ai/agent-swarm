import { readFileSync } from "node:fs";
import path from "node:path";

export type VendoredOpenapiManifestEntry = {
  slug: string;
  name: string;
  domain: string;
  specFile: string;
  specSourceUrl: string;
  specVersionPin: string;
  baseUrl: string;
  categories: string[];
  presetId?: string;
  docsUrl: string;
  blessedOperations: string[];
  specSha256: string;
  refreshMode?: "openapi" | "operator-review";
};

type VendoredOpenapiManifest = {
  version: 1;
  integrations: VendoredOpenapiManifestEntry[];
};

export const VENDORED_OPENAPI_DIR = "vendored-openapi";

function vendoredOpenapiDirectories(): string[] {
  const explicitPath = process.env.VENDORED_OPENAPI_DIR;
  return [
    ...(explicitPath ? [explicitPath] : []),
    path.join(process.cwd(), VENDORED_OPENAPI_DIR),
    path.join(process.cwd(), "..", VENDORED_OPENAPI_DIR),
    path.join("/app", VENDORED_OPENAPI_DIR),
  ];
}

export function resolveVendoredOpenapiDirectory(): string | null {
  for (const candidate of vendoredOpenapiDirectories()) {
    try {
      readFileSync(path.join(candidate, "manifest.json"), "utf-8");
      return candidate;
    } catch {
      // Try the next source-checkout or Docker-image location.
    }
  }
  return null;
}

export function loadVendoredOpenapiManifest(): VendoredOpenapiManifest | null {
  const directory = resolveVendoredOpenapiDirectory();
  if (!directory) return null;
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "manifest.json"), "utf-8"),
    ) as VendoredOpenapiManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.integrations)) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function listVendoredOpenapiEntries(): VendoredOpenapiManifestEntry[] {
  return loadVendoredOpenapiManifest()?.integrations ?? [];
}

export function readVendoredOpenapiSpec(slug: string): {
  entry: VendoredOpenapiManifestEntry;
  specJson: string;
} {
  const manifest = loadVendoredOpenapiManifest();
  const directory = resolveVendoredOpenapiDirectory();
  if (!manifest || !directory) throw new Error("Vendored OpenAPI manifest is unavailable.");
  const entry = manifest.integrations.find((candidate) => candidate.slug === slug);
  if (!entry) throw new Error(`Unknown vendored OpenAPI spec: ${slug}.`);
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(entry.specFile)) {
    throw new Error(`Invalid vendored OpenAPI spec file for ${slug}.`);
  }
  return { entry, specJson: readFileSync(path.join(directory, entry.specFile), "utf-8") };
}
