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

/** `args` with the tool's sensitive fields replaced by a marker, for a telemetry preview. */
export function telemetryToolArgs(tool: string | undefined, args: unknown): unknown {
  const rule = tool ? REDACTED_TOOL_PAYLOADS[tool] : undefined;
  if (!rule || args === undefined) return args;
  // A raw string or other shape could hold the SQL anywhere: drop it whole.
  if (!args || typeof args !== "object" || Array.isArray(args)) return TELEMETRY_OMITTED;
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of rule.args) if (key in copy) copy[key] = TELEMETRY_OMITTED;
  return copy;
}

/** True when a tool's result must not appear in a telemetry preview. */
export function telemetryOmitsToolResult(tool: string | undefined): boolean {
  return tool ? (REDACTED_TOOL_PAYLOADS[tool]?.result ?? false) : false;
}
