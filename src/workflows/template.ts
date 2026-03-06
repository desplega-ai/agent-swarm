/**
 * Replace {{path.to.value}} tokens in a template string
 * with values from the context object.
 */
export function interpolate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const keys = path.trim().split(".");
    let value: unknown = ctx;
    for (const key of keys) {
      if (value == null || typeof value !== "object") return "";
      value = (value as Record<string, unknown>)[key];
    }
    if (value == null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}
