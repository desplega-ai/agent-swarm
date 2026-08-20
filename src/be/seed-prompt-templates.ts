/**
 * Seed default prompt templates into the DB from the in-memory code registry.
 *
 * Called from initDb() after migrations run. Ensures every registered
 * EventTemplateDefinition has a corresponding global default in the
 * prompt_templates table.
 */

import { getPromptTemplateDefaultDrift } from "../prompts/default-drift";
import { getAllTemplateDefinitions } from "../prompts/registry";
import { getPromptTemplates, resetPromptTemplateToDefault, upsertPromptTemplate } from "./db";

// Side-effect imports: register ALL template definitions so they're seeded on API startup.
// Webhook handler templates (github, gitlab, etc.) are loaded transitively by the API server's
// handler imports, but runner/session templates are only loaded by the worker. Importing them
// here ensures all templates are available for the render endpoint and seeded to the DB.
import "../prompts/session-templates";
import "../commands/templates";
import "../tools/templates";

/**
 * Seed default templates into the DB.
 *
 * For each registered EventTemplateDefinition:
 * - If no global record exists at all, insert one as default (isDefault=true, state=enabled)
 * - If a global default (isDefault=true) exists and its body differs from code, update it
 * - Reclassify a customized record as default when its body is byte-identical to code
 * - Warn, but never overwrite, when a genuinely customized record differs from code
 */
export function seedDefaultTemplates(): void {
  const definitions = getAllTemplateDefinitions();

  if (definitions.length === 0) {
    return; // No templates registered yet — expected during early phases
  }

  for (const def of definitions) {
    // Look for ALL existing global records for this eventType (both default and customized)
    const allGlobal = getPromptTemplates({
      eventType: def.eventType,
      scope: "global",
    });

    const globalRecord = allGlobal.find((t) => t.scopeId === null);

    if (!globalRecord) {
      // No global record at all — seed one with isDefault=true directly.
      upsertPromptTemplate({
        eventType: def.eventType,
        scope: "global",
        body: def.defaultBody,
        createdBy: "system",
        changeReason: "Seeded from code registry",
        isDefault: true,
      });
    } else if (globalRecord.isDefault && globalRecord.body !== def.defaultBody) {
      // Global default exists but body has drifted from code — update it.
      // Only update if the record is still marked as default (not user-customized).
      resetPromptTemplateToDefault(globalRecord.id, def.defaultBody);
    } else if (!globalRecord.isDefault) {
      const drift = getPromptTemplateDefaultDrift(globalRecord, def.defaultBody);
      if (drift.defaultDrifted) {
        const ageMs = Math.max(0, Date.now() - Date.parse(globalRecord.updatedAt));
        const frozenDays = Math.floor(ageMs / 86_400_000);
        const frozenHours = Math.floor(ageMs / 3_600_000);
        const frozenFor =
          frozenDays > 0
            ? `${frozenDays} day${frozenDays === 1 ? "" : "s"}`
            : `${frozenHours} hour${frozenHours === 1 ? "" : "s"}`;
        const signedByteDelta = drift.byteDelta > 0 ? `+${drift.byteDelta}` : `${drift.byteDelta}`;

        console.warn(
          `[prompt-templates] Customized template "${def.eventType}" has drifted from its code default; frozen for ${frozenFor} since ${globalRecord.updatedAt}; byte delta ${signedByteDelta} (code default ${drift.defaultBytes} bytes, customization ${drift.customizedBytes} bytes). The customization was preserved; reset it manually to reconcile.`,
        );
      } else {
        // The row was marked customized without any content change. Restore default ownership so
        // future code-default updates continue to reconcile it.
        resetPromptTemplateToDefault(globalRecord.id, def.defaultBody);
      }
    }
    // If record exists with isDefault=false and a different body: never overwrite it
    // If record exists with isDefault=true and body matches: leave it alone
  }
}
