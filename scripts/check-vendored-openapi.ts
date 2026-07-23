#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, type Manifest, sha256, trimOpenapiSpec } from "./vendored-openapi-utils";

const directory = path.join(process.cwd(), "vendored-openapi");
const manifest = JSON.parse(
  readFileSync(path.join(directory, "manifest.json"), "utf-8"),
) as Manifest;

if (manifest.version !== 1 || !Array.isArray(manifest.integrations)) {
  throw new Error("vendored-openapi/manifest.json must contain version 1 integrations.");
}
const slugs = new Set<string>();
for (const entry of manifest.integrations) {
  if (!entry.slug || slugs.has(entry.slug))
    throw new Error(`Duplicate or missing manifest slug: ${entry.slug}.`);
  slugs.add(entry.slug);
  if (
    !entry.name ||
    !entry.specSourceUrl.startsWith("https://") ||
    !entry.specVersionPin ||
    !["machine-openapi", "operator-reference"].includes(entry.sourceSemantics) ||
    !Array.isArray(entry.categories) ||
    !Array.isArray(entry.blessedOperations) ||
    !/^[a-f0-9]{64}$/.test(entry.specSha256)
  ) {
    throw new Error(`${entry.slug}: manifest entry is missing required blessed metadata.`);
  }
  if (
    entry.refreshMode === "operator-review"
      ? entry.sourceSemantics !== "operator-reference"
      : entry.sourceSemantics !== "machine-openapi" ||
        !entry.sourceSha256 ||
        !/^[a-f0-9]{64}$/.test(entry.sourceSha256) ||
        !entry.upstreamVersion
  ) {
    throw new Error(`${entry.slug}: refresh mode and source provenance metadata disagree.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(entry.specFile)) {
    throw new Error(`${entry.slug}: specFile must be a local JSON filename.`);
  }
  if (
    !entry.baseUrl.startsWith("https://") ||
    !entry.domain ||
    !entry.docsUrl.startsWith("https://")
  ) {
    throw new Error(`${entry.slug}: manifest URL metadata is invalid.`);
  }
  const specText = readFileSync(path.join(directory, entry.specFile), "utf-8");
  const spec = JSON.parse(specText) as unknown;
  const canonical = canonicalJson(trimOpenapiSpec(spec, entry));
  if (specText !== canonical)
    throw new Error(`${entry.slug}: spec is not the deterministic blessed trim.`);
  if (sha256(specText) !== entry.specSha256)
    throw new Error(`${entry.slug}: specSha256 does not match ${entry.specFile}.`);
}
console.log(`Vendored OpenAPI check passed for ${manifest.integrations.length} specs.`);
