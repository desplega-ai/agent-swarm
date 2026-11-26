/**
 * Tool calls whose payload carries user data that must never reach a telemetry
 * exporter. `data-query` SQL holds customer literals and its result holds file
 * rows (and agent-fs errors that quote the SQL), so neither belongs in a span's
 * args or result preview. Shared by the API registrar spans and the worker's
 * harness tool spans; worker-safe (no DB imports).
 */
const REDACTED_TOOL_PAYLOADS: Record<string, { args: readonly string[]; result: boolean }> = {
  "data-query": { args: ["sql"], result: true },
};

export const TELEMETRY_OMITTED = "[omitted]";

/**
 * The redaction rule for a tool id as a harness reports it. Harnesses prefix MCP
 * tool ids differently (Claude `mcp__<server>__<tool>`, OpenCode
 * `swarm_<tool>`), so a prefixed id falls back to its bare tool name.
 */
function redactionRule(tool: string | undefined) {
  if (!tool) return undefined;
  const exact = REDACTED_TOOL_PAYLOADS[tool];
  if (exact) return exact;
  let bare = tool;
  if (bare.startsWith("mcp__")) bare = bare.split("__").slice(2).join("__");
  else if (bare.startsWith("swarm_")) bare = bare.slice("swarm_".length);
  return REDACTED_TOOL_PAYLOADS[bare];
}

/**
 * `args` with the tool's sensitive fields replaced by a marker, for a telemetry
 * preview. Harnesses wrap MCP arguments differently (Codex emits
 * `{ server, tool, arguments: { sql } }`, others pass `{ sql }` flat, some hand a
 * JSON string), so the sensitive keys are redacted at every depth and a nested
 * JSON string is parsed and redacted too.
 */
export function telemetryToolArgs(tool: string | undefined, args: unknown): unknown {
  const rule = redactionRule(tool);
  if (!rule || args === undefined) return args;
  // A raw string or other shape could hold the SQL anywhere: drop it whole.
  if (!args || typeof args !== "object" || Array.isArray(args)) return TELEMETRY_OMITTED;
  return redactPayload(args, new Set(rule.args), 0);
}

// shortcut: a payload nested deeper than this is dropped whole; raise it if a
// harness envelope ever legitimately nests further.
const MAX_REDACTION_DEPTH = 8;

function redactPayload(value: unknown, keys: ReadonlySet<string>, depth: number): unknown {
  if (typeof value === "string") {
    const parsed = parseJsonContainer(value);
    // A string holding one of the sensitive keys that does not parse (cut, or
    // not JSON) cannot be redacted field by field: drop it.
    if (parsed === undefined) {
      return [...keys].some((key) => value.includes(key)) ? TELEMETRY_OMITTED : value;
    }
    return JSON.stringify(redactPayload(parsed, keys, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_REDACTION_DEPTH) return TELEMETRY_OMITTED;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, keys, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = keys.has(key) ? TELEMETRY_OMITTED : redactPayload(field, keys, depth + 1);
  }
  return copy;
}

function parseJsonContainer(value: string): object | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True when a tool's result must not appear in a telemetry preview. */
export function telemetryOmitsToolResult(tool: string | undefined): boolean {
  return redactionRule(tool)?.result ?? false;
}
