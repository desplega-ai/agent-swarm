#!/usr/bin/env bun
/**
 * Install a predefined extension (templates/extensions/<name>) through the REST API.
 * The API installs from its bundled catalog, so the template must be in the catalog
 * the server was built with (`bun run build:extension-catalog`).
 *
 * Usage: bun scripts/extensions/install-template.ts <name> [--config '<json>'] [--enable] [--validate-only]
 * Env: MCP_BASE_URL (default http://localhost:3013), AGENT_SWARM_API_KEY or API_KEY.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildExtensionCatalog } from "../../src/extensions/catalog-build";
import { getApiKey } from "../../src/utils/api-key";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    enable: { type: "boolean", default: false },
    "validate-only": { type: "boolean", default: false },
  },
});

const name = positionals[0];
if (!name) {
  console.error("usage: install-template.ts <name> [--config json] [--enable] [--validate-only]");
  process.exit(2);
}
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
  console.error(`invalid template name "${name}": use lowercase letters, digits, and hyphens`);
  process.exit(2);
}
const config = values.config ? JSON.parse(values.config) : undefined;

if (values["validate-only"]) {
  // Validate the working-tree template, the same way the catalog generator and install do.
  const catalog = await buildExtensionCatalog(join(import.meta.dir, "../../templates/extensions"));
  const entry = catalog[name];
  if (!entry) {
    console.error(`no predefined extension named "${name}"`);
    process.exit(1);
  }
  const { validateBundle } = await import("../../src/be/extensions/validate");
  const { preflightAssets } = await import("../../src/be/extensions/assets");
  const result = await validateBundle({ manifest: entry.manifest, files: entry.files });
  // Install also typechecks scripts and checks schedule timing; run those too.
  const assets = result.ok ? await preflightAssets(entry.manifest, entry.files) : null;
  const diagnostics = [
    ...(result.ok ? [] : result.diagnostics),
    ...(assets && !assets.ok ? assets.diagnostics : []),
  ];
  console.log(JSON.stringify({ ok: diagnostics.length === 0, diagnostics }, null, 2));
  process.exit(diagnostics.length === 0 ? 0 : 1);
}

const baseUrl = (process.env.MCP_BASE_URL ?? "http://localhost:3013").replace(/\/$/, "");
const apiKey = getApiKey();
if (!apiKey) {
  console.error("AGENT_SWARM_API_KEY or API_KEY is required");
  process.exit(2);
}
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

const install = await fetch(`${baseUrl}/api/extensions/install`, {
  method: "POST",
  headers,
  body: JSON.stringify({ template: name, ...(config ? { config } : {}) }),
});
const installed = (await install.json()) as {
  extension?: { id: string; version: number };
  error?: unknown;
};
if (!install.ok || !installed.extension) {
  console.error(`install failed (${install.status}):`, JSON.stringify(installed, null, 2));
  process.exit(1);
}
console.log(`installed ${name} v${installed.extension.version} (${installed.extension.id})`);

if (values.enable) {
  const enable = await fetch(`${baseUrl}/api/extensions/${installed.extension.id}/enable`, {
    method: "POST",
    headers,
  });
  const enabled = await enable.json();
  if (!enable.ok) {
    console.error(`enable failed (${enable.status}):`, JSON.stringify(enabled, null, 2));
    process.exit(1);
  }
  console.log(`enabled ${name}`);
}
