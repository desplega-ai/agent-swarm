/**
 * Generate JSON Schema for file-based imports (#2494).
 *
 * Source of truth: `src/be/import/schema.ts`
 * Output:          `templates/import/manifest.schema.json` (package `swarm-import.*`)
 *                  `templates/import/sources.schema.json`  (`SWARM_IMPORT_SOURCES[_FILE]`)
 *
 * Usage:  bun run build:import-schema
 *         bun run check:import-schema    # CI drift check, no write
 */

import { join } from "node:path";
import { z } from "zod";
import { ImportManifestSchema, ImportSourcesSchema } from "../src/be/import/schema";

const OUT_DIR = join(import.meta.dir, "..", "templates", "import");
const BASE = "https://github.com/desplega-ai/agent-swarm/blob/main/templates/import";

const outputs = {
  "manifest.schema.json": {
    schema: ImportManifestSchema,
    title: "Agent Swarm import manifest",
    description:
      "Optional swarm-import.{yaml,yml,json} at a package root. Item ids are source-local. Without it the directory convention applies: workflows/*.{yaml,yml,json}, skills/<id>/SKILL.md, scripts/*.ts, agents/<name>.md.",
  },
  "sources.schema.json": {
    schema: ImportSourcesSchema,
    title: "Agent Swarm import sources",
    description: "Value of SWARM_IMPORT_SOURCES (JSON) or the file SWARM_IMPORT_SOURCES_FILE names.",
  },
};

let stale = false;
for (const [file, { schema, title, description }] of Object.entries(outputs)) {
  const document = {
    ...z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
    $id: `${BASE}/${file}`,
    title,
    description,
  };
  const generated = `${JSON.stringify(document, null, 2)}\n`;
  const path = join(OUT_DIR, file);
  if (process.argv.includes("--check")) {
    const out = Bun.file(path);
    if (!(await out.exists()) || (await out.text()) !== generated) {
      console.error(`[build-import-schema] ${file} is stale. Run \`bun run build:import-schema\`.`);
      stale = true;
    }
  } else {
    await Bun.write(path, generated);
    console.log(`[build-import-schema] wrote ${path}`);
  }
}
if (stale) process.exit(1);
