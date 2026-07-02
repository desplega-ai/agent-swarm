/**
 * In-memory template definition registry.
 *
 * Code-defined templates register their header, defaultBody, variables, and category here
 * at module load time. The DB layer (prompt_templates table) stores runtime overrides.
 */

export interface VariableDefinition {
  name: string;
  description: string;
  example?: string;
}

export interface EventTemplateDefinition {
  /** Dot-separated event identifier, e.g. "github.pull_request.review_submitted" */
  eventType: string;
  /** Always-on prefix (code-defined, not overridable), uses {{var}} syntax */
  header: string;
  /** Hardcoded fallback body used when no DB override exists */
  defaultBody: string;
  /** Variable definitions for documentation and validation */
  variables: VariableDefinition[];
  /** Category for grouping in the UI */
  category: "event" | "system" | "common" | "task_lifecycle" | "session";
}

const templateDefinitions = new Map<string, EventTemplateDefinition>();

/**
 * Register a template definition in the in-memory registry.
 * Called at module load time by event handler modules.
 */
export function registerTemplate(def: EventTemplateDefinition): void {
  templateDefinitions.set(def.eventType, def);
}

/**
 * Look up a template definition by eventType.
 */
export function getTemplateDefinition(eventType: string): EventTemplateDefinition | undefined {
  return templateDefinitions.get(eventType);
}

/**
 * Return all registered template definitions.
 */
export function getAllTemplateDefinitions(): EventTemplateDefinition[] {
  return Array.from(templateDefinitions.values());
}

/**
 * Clear all registered template definitions.
 * Only used in tests to reset state between runs.
 */
export function clearTemplateDefinitions(): void {
  templateDefinitions.clear();
}
