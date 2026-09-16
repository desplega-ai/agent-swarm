#!/usr/bin/env bun
/**
 * Install an extension template from templates/extensions/<name> through the REST API.
 *
 * Usage: bun scripts/extensions/install-template.ts <name> [--config '<json>'] [--enable] [--validate-only]
 * Env: MCP_BASE_URL (default http://localhost:3013), API_KEY or AGENT_SWARM_API_KEY.
 */
import { parseArgs } from "node:util";

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
// Template names are directory names under templates/extensions. Reject anything
// else so the name can never escape that directory or hit a cryptic ENOENT.
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`invalid template name "${name}": use lowercase letters, digits, and hyphens`);
  process.exit(2);
}

const directory = new URL(`../../templates/extensions/${name}/`, import.meta.url);
const manifest = await Bun.file(new URL("manifest.json", directory)).json();
const hooks = await Bun.file(new URL(manifest.assets.hooks, directory)).text();
const config = values.config ? JSON.parse(values.config) : undefined;
const bundle = {
  manifest,
  files: { [manifest.assets.hooks]: hooks },
  ...(config ? { config } : {}),
};

if (values["validate-only"]) {
  const { validateBundle } = await import("../../src/be/extensions/validate");
  const result = await validateBundle(bundle);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const baseUrl = (process.env.MCP_BASE_URL ?? "http://localhost:3013").replace(/\/$/, "");
const apiKey = process.env.AGENT_SWARM_API_KEY ?? process.env.API_KEY;
if (!apiKey) {
  console.error("API_KEY or AGENT_SWARM_API_KEY is required");
  process.exit(2);
}
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

const install = await fetch(`${baseUrl}/api/extensions/install`, {
  method: "POST",
  headers,
  body: JSON.stringify(bundle),
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
