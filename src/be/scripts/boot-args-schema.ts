/**
 * Post-listen backfill: re-extract `argsJsonSchema` for stored scripts, so rows
 * saved before the extractor marked `.default()` fields optional get the
 * corrected schema without a re-upsert. Runs once per boot, async/non-blocking,
 * idempotent: a second run finds every schema equal and rewrites nothing.
 *
 * Uses the same `extractArgsJsonSchema` as `script_upsert`. The write is
 * in place: no new version, `updatedAt` untouched. Scratch scripts are skipped
 * (`listScripts` default). Scripts with no stored schema are skipped too: they
 * have no stale `required` list to fix, and re-extracting them would only spawn
 * a subprocess per script on every boot.
 *
 * Mirrors the script embedding backfill (src/be/scripts/boot-reembed.ts).
 */

import { getDbClient } from "../db";
import { listScripts } from "./db";
import { extractArgsJsonSchema } from "./extract-schema";

export async function runBootArgsSchemaBackfill(): Promise<void> {
  const scripts = (await listScripts()).filter((script) => script.argsJsonSchema);
  if (scripts.length === 0) return;

  let rewrote = 0;
  for (const script of scripts) {
    try {
      const next = await extractArgsJsonSchema(script.source);
      // null means no argsSchema or a failed extraction: keep the stored schema.
      if (next === null || next === script.argsJsonSchema) continue;
      // Compare-and-set on contentHash: an upsert that changed the source in
      // between wrote its own fresh schema, so this stale one must not win.
      const { changes } = await getDbClient().run(
        "UPDATE scripts SET argsJsonSchema = ? WHERE id = ? AND contentHash = ?",
        [next, script.id, script.contentHash],
      );
      rewrote += changes;
    } catch (err) {
      console.error(`[boot-args-schema] failed for "${script.name}":`, (err as Error).message);
    }
  }

  console.log(`[boot-args-schema] rewrote ${rewrote} of ${scripts.length} script schemas`);
}
