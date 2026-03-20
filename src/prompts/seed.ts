/**
 * Seed default prompt templates into the DB from the in-memory code registry.
 *
 * Called from initDb() after migrations run. Ensures every registered
 * EventTemplateDefinition has a corresponding global default in the
 * prompt_templates table.
 */

import { getPromptTemplates, resetPromptTemplateToDefault, upsertPromptTemplate } from "../be/db";
import { getAllTemplateDefinitions } from "./registry";

/**
 * Seed default templates into the DB.
 *
 * For each registered EventTemplateDefinition:
 * - If no global record exists at all, insert one as default (isDefault=true, state=enabled)
 * - If a global default (isDefault=true) exists and its body differs from code, update it
 * - Never touch records where isDefault=false (user customizations)
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
      // No global record at all — seed one.
      // upsertPromptTemplate inserts with isDefault=0, so we immediately
      // resetPromptTemplateToDefault to flip isDefault=true.
      const template = upsertPromptTemplate({
        eventType: def.eventType,
        scope: "global",
        body: def.defaultBody,
        createdBy: "system",
        changeReason: "Seeded from code registry",
      });

      resetPromptTemplateToDefault(template.id, def.defaultBody);
    } else if (globalRecord.isDefault && globalRecord.body !== def.defaultBody) {
      // Global default exists but body has drifted from code — update it.
      // Only update if the record is still marked as default (not user-customized).
      resetPromptTemplateToDefault(globalRecord.id, def.defaultBody);
    }
    // If record exists with isDefault=false (user customization): leave it alone
    // If record exists with isDefault=true and body matches: leave it alone
  }
}
