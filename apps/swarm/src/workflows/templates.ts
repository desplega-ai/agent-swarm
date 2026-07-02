import type { WorkflowDefinition, WorkflowTemplate } from "../types";

/**
 * Validate that all required template variables are provided.
 * Returns a list of missing required variable names.
 */
export function validateTemplateVariables(
  template: WorkflowTemplate,
  provided: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const variable of template.variables) {
    if (variable.required && !(variable.name in provided)) {
      // Check if there's a default value
      if (variable.default === undefined) {
        missing.push(variable.name);
      }
    }
  }
  return missing;
}

/**
 * Instantiate a workflow template with the given variables.
 *
 * 1. Validates all required variables are provided
 * 2. Deep-clones the template definition
 * 3. Replaces `{{variable}}` placeholders in all string fields
 * 4. Returns a valid WorkflowDefinition
 */
export function instantiateTemplate(
  template: WorkflowTemplate,
  variables: Record<string, unknown>,
): WorkflowDefinition {
  // Validate required variables
  const missing = validateTemplateVariables(template, variables);
  if (missing.length > 0) {
    throw new Error(`Missing required template variables: ${missing.join(", ")}`);
  }

  // Build resolved variables (apply defaults for missing optional vars)
  const resolved: Record<string, unknown> = {};
  for (const variable of template.variables) {
    if (variable.name in variables) {
      resolved[variable.name] = variables[variable.name];
    } else if (variable.default !== undefined) {
      resolved[variable.name] = variable.default;
    }
  }

  // Deep-clone the definition and replace placeholders
  const cloned = JSON.parse(JSON.stringify(template.definition)) as WorkflowDefinition;
  return replaceVariables(cloned, resolved);
}

/**
 * Deep-replace `{{variableName}}` placeholders in all string fields of an object.
 */
function replaceVariables<T>(obj: T, variables: Record<string, unknown>): T {
  if (typeof obj === "string") {
    return replaceStringPlaceholders(obj, variables) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => replaceVariables(item, variables)) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceVariables(value, variables);
    }
    return result as T;
  }
  return obj;
}

/**
 * Replace `{{variableName}}` patterns in a string with variable values.
 */
function replaceStringPlaceholders(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) return _match; // Leave unresolved placeholders as-is
    if (typeof value === "object" && value !== null) return JSON.stringify(value);
    return String(value);
  });
}
