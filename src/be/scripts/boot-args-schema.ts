/**
 * Post-listen backfill: normalize stored `argsJsonSchema` JSON, so rows
 * saved before the extractor marked `.default()` fields optional get the
 * corrected schema without a re-upsert. Runs once per boot, async/non-blocking,
 * idempotent: a second run finds every schema equal and rewrites nothing.
 *
 * This removes defaulted properties from `required` without executing script source.
 * The write creates no version and preserves `updatedAt`. Scratch scripts and
 * scripts without a stored schema are skipped.
 *
 * Mirrors the script embedding backfill (src/be/scripts/boot-reembed.ts).
 */

import { getDbClient } from "../db";
import { listScripts } from "./db";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize schema nodes without changing literal values in default, const, or enum. */
function optionalDefaults(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  let changed = false;
  if (Array.isArray(schema.required) && isObject(schema.properties)) {
    const properties = schema.properties;
    const required = schema.required.filter((name) => {
      const property = typeof name === "string" ? properties[name] : undefined;
      return !isObject(property) || !Object.hasOwn(property, "default");
    });
    if (required.length !== schema.required.length) {
      if (required.length) schema.required = required;
      else delete schema.required;
      changed = true;
    }
  }
  for (const key of [
    "properties",
    "$defs",
    "definitions",
    "patternProperties",
    "dependentSchemas",
  ]) {
    const children = schema[key];
    if (isObject(children)) {
      for (const child of Object.values(children)) changed = optionalDefaults(child) || changed;
    }
  }
  for (const key of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "allOf",
    "anyOf",
    "oneOf",
    "prefixItems",
  ]) {
    const children = schema[key];
    if (Array.isArray(children)) {
      for (const child of children) changed = optionalDefaults(child) || changed;
    } else {
      changed = optionalDefaults(children) || changed;
    }
  }
  return changed;
}

export async function runBootArgsSchemaBackfill(): Promise<void> {
  const scripts = (await listScripts()).filter((script) => script.argsJsonSchema);
  if (scripts.length === 0) return;

  let rewrote = 0;
  for (const script of scripts) {
    let schema: unknown;
    try {
      schema = JSON.parse(script.argsJsonSchema as string);
    } catch {
      // Preserve malformed legacy values for explicit repair through script_upsert.
      continue;
    }
    if (!optionalDefaults(schema)) continue;
    // A concurrent upsert must retain its own source and schema.
    const { changes } = await getDbClient().run(
      "UPDATE scripts SET argsJsonSchema = ? WHERE id = ? AND contentHash = ? AND argsJsonSchema = ?",
      [JSON.stringify(schema), script.id, script.contentHash, script.argsJsonSchema],
    );
    rewrote += changes;
  }

  console.log(`[boot-args-schema] rewrote ${rewrote} of ${scripts.length} script schemas`);
}
