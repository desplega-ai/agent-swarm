/**
 * Generate the JSON Schema for extension manifests.
 *
 * Source of truth: `ExtensionManifestSchema` in `src/types.ts`
 * Output:          `templates/extensions/manifest.schema.json`
 *
 * Manifests reference it for editor typing: YAML with
 * `# yaml-language-server: $schema=../manifest.schema.json`, JSON with
 * `"$schema": "../manifest.schema.json"`. Refinements (name prefix, schedule
 * script cross-references, cron-xor-interval) cannot be expressed in JSON
 * Schema; the catalog generator and install enforce them.
 *
 * Usage:  bun run build:extension-schema
 *         bun run check:extension-schema    # CI drift check, no write
 */

import { join } from "node:path";
import { z } from "zod";
import { ExtensionManifestSchema } from "../src/types";

const REPO_ROOT = join(import.meta.dir, "..");
const OUT_PATH = join(REPO_ROOT, "templates", "extensions", "manifest.schema.json");

function build(): string {
  const schema = z.toJSONSchema(ExtensionManifestSchema, { target: "draft-7", io: "input" });
  const document = {
    ...schema,
    $id: "https://github.com/desplega-ai/agent-swarm/blob/main/templates/extensions/manifest.schema.json",
    title: "Agent Swarm extension manifest",
    description:
      "Manifest for a predefined agent-swarm extension (templates/extensions/<name>/manifest.{yaml,yml,json}). Asset names must start with `<name>-`; schedules must reference a declared script and set exactly one of cronExpression or intervalMs. Those rules are enforced at build and install time, not by this schema.",
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const generated = build();

if (process.argv.includes("--check")) {
  const out = Bun.file(OUT_PATH);
  const current = (await out.exists()) ? await out.text() : "";
  if (current !== generated) {
    console.error(
      "[build-extension-manifest-schema] manifest.schema.json is stale.\n" +
        "Run `bun run build:extension-schema` and commit the result.",
    );
    process.exit(1);
  }
  console.log("[build-extension-manifest-schema] up to date");
} else {
  await Bun.write(OUT_PATH, generated);
  console.log(`[build-extension-manifest-schema] wrote ${OUT_PATH}`);
}
