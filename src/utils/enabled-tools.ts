/**
 * Parse the `SWARM_ENABLED_TOOLS` MCP tool allowlist.
 *
 * Accepts a comma-separated list (`get-tasks, store-progress`) or a JSON array
 * of strings. Returns `undefined` when the value is unset, blank, or holds no
 * entries, so callers keep the capability-driven surface. Throws on a JSON
 * array that does not parse to strings.
 */
export function parseEnabledTools(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let entries: string[];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error("Expected a JSON array of tool names");
    }
    entries = parsed;
  } else {
    entries = trimmed.split(",");
  }

  const tools = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
  return tools.length > 0 ? tools : undefined;
}
