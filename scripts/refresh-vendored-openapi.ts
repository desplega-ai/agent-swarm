#!/usr/bin/env bun
/** Fetch each pinned upstream OpenAPI document, retain the blessed operations, and update checksums. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, type Manifest, sha256, trimOpenapiSpec } from "./vendored-openapi-utils";

const directory = path.join(process.cwd(), "vendored-openapi");
const manifestPath = path.join(directory, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
const staged: Array<{ entry: Manifest["integrations"][number]; target: string; next: string }> = [];

for (const entry of manifest.integrations) {
  if (entry.refreshMode === "operator-review") {
    const target = path.join(directory, entry.specFile);
    const previous = readFileSync(target, "utf-8");
    const next = canonicalJson(trimOpenapiSpec(JSON.parse(previous), entry));
    console.log(
      `${entry.slug}: operator-review reference ${entry.specSourceUrl}; local ${new TextEncoder().encode(previous).byteLength} bytes -> ${new TextEncoder().encode(next).byteLength} bytes (${previous === next ? "unchanged" : "updated"})`,
    );
    staged.push({ entry, target, next });
    continue;
  }
  let response: Response;
  try {
    response = await fetch(entry.specSourceUrl);
  } catch (error) {
    throw new Error(`${entry.slug}: fetch failed for ${entry.specSourceUrl}: ${String(error)}`);
  }
  if (!response.ok) {
    throw new Error(
      `${entry.slug}: ${entry.specSourceUrl} returned HTTP ${response.status} ${response.statusText}.`,
    );
  }
  const raw = await response.text();
  const rawBytes = new TextEncoder().encode(raw).byteLength;
  if (entry.sourceSha256 && sha256(raw) !== entry.sourceSha256) {
    throw new Error(
      `${entry.slug}: ${entry.specSourceUrl} content SHA-256 did not match sourceSha256 ${entry.sourceSha256}.`,
    );
  }
  const upstream = JSON.parse(raw) as Record<string, unknown>;
  const upstreamVersion = (upstream.info as { version?: unknown } | undefined)?.version;
  if (entry.upstreamVersion && upstreamVersion !== entry.upstreamVersion) {
    throw new Error(
      `${entry.slug}: ${entry.specSourceUrl} reported version ${String(upstreamVersion)}, expected ${entry.upstreamVersion}.`,
    );
  }
  const next = canonicalJson(trimOpenapiSpec(upstream, entry));
  const target = path.join(directory, entry.specFile);
  const previous = readFileSync(target, "utf-8");
  const trimmedBytes = new TextEncoder().encode(next).byteLength;
  console.log(
    `${entry.slug}: ${entry.specSourceUrl} HTTP ${response.status}; raw ${rawBytes} bytes -> trimmed ${trimmedBytes} bytes (${previous === next ? "unchanged" : "updated"})`,
  );
  staged.push({ entry, target, next });
}

// Do not leave a partial refresh if an upstream fetch or trim fails above.
for (const { entry, target, next } of staged) {
  writeFileSync(target, next);
  entry.specSha256 = sha256(next);
}
writeFileSync(manifestPath, canonicalJson(manifest));
console.log(`Refreshed ${staged.length} vendored specs and manifest checksums.`);
