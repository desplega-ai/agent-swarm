#!/usr/bin/env bun

/**
 * sync-plugin-versions — keep every harness plugin descriptor's `version`
 * equal to package.json's `version`.
 *
 * The operator skill (`skills/agent-swarm`) is exposed as a plugin to Claude
 * Code, Codex, Cursor, Devin, Kimi, Gemini, and Antigravity through the
 * descriptor files listed below. Each carries its own version field, and a
 * stale one ships an old-looking plugin.
 *
 * Usage:
 *   bun scripts/sync-plugin-versions.ts          # rewrite descriptors
 *   bun scripts/sync-plugin-versions.ts --check  # exit 1 on drift
 */

type Target = { path: string; field: string[] };

const TARGETS: Target[] = [
  { path: ".claude-plugin/plugin.json", field: ["version"] },
  { path: ".claude-plugin/marketplace.json", field: ["plugins", "0", "version"] },
  { path: ".codex-plugin/plugin.json", field: ["version"] },
  { path: ".cursor-plugin/plugin.json", field: ["version"] },
  { path: ".devin-plugin/plugin.json", field: ["version"] },
  { path: ".kimi-plugin/plugin.json", field: ["version"] },
  { path: "gemini-extension.json", field: ["version"] },
];

const packageVersion = ((await Bun.file("package.json").json()) as { version: string }).version;
const check = process.argv.includes("--check");
let drift = 0;

for (const target of TARGETS) {
  const text = await Bun.file(target.path).text();
  const doc = JSON.parse(text) as Record<string, unknown>;
  let node: Record<string, unknown> = doc;
  for (const key of target.field.slice(0, -1)) {
    node = node[key] as Record<string, unknown>;
  }
  const last = target.field[target.field.length - 1];
  const current = node[last];
  if (current === packageVersion) continue;
  drift += 1;
  if (check) {
    console.error(
      `${target.path}: ${target.field.join(".")} is ${current}, expected ${packageVersion}`,
    );
    continue;
  }
  node[last] = packageVersion;
  await Bun.write(target.path, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Synced ${target.path} to ${packageVersion}`);
}

if (check && drift > 0) {
  console.error("Run `bun run sync-plugin-versions` and commit the result.");
  process.exit(1);
}
if (drift === 0) console.log(`Plugin descriptors match package.json version ${packageVersion}`);
