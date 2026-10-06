import { getResolvedConfig } from "../be/db";

/**
 * Look up a config value by key. Falls back to `process.env` when no
 * swarm_config row exists — mirrors the resolution order used elsewhere
 * (see `loadGlobalConfigsIntoEnv`).
 *
 * Returns the trimmed value or `null` if unset/empty.
 */
export async function resolveConfigValue(key: string): Promise<string | null> {
  const configs = await getResolvedConfig();
  // The setup CLI persists keys in lowercase (e.g. `managed_agent_id`) while
  // the docker-entrypoint hydrates env vars in uppercase (`MANAGED_AGENT_ID`).
  // Look up both variants so this endpoint works against either shape.
  const variants = [key, key.toLowerCase(), key.toUpperCase()];
  for (const variant of variants) {
    const row = configs.find((c) => c.key === variant);
    if (row && typeof row.value === "string" && row.value.length > 0) {
      return row.value;
    }
  }
  // Env fallback — the row may not exist if the operator deployed via env
  // file rather than swarm_config.
  const envValue = process.env[key];
  if (envValue && envValue.length > 0) return envValue;
  return null;
}

/**
 * Public, browser-facing API origin with swarm_config precedence. The dashboard
 * (`GET /api/integrations/mcp-user-config`) and the connector-code route both
 * read it, so they always agree.
 */
export async function resolveMcpBaseUrl(): Promise<string> {
  // Browser-facing connect URLs: prefer the public ingress origin
  // (PUBLIC_MCP_BASE_URL) over the internal MCP_BASE_URL so split deployments
  // (Helm) surface a host the user's browser can actually reach. Both honor the
  // swarm_config → env resolution order. Falls back to the localhost dev base.
  const configured =
    (await resolveConfigValue("PUBLIC_MCP_BASE_URL")) ?? (await resolveConfigValue("MCP_BASE_URL"));
  const fallback = `http://localhost:${process.env.PORT || "3013"}`;
  return (configured || fallback).replace(/\/+$/, "");
}

/**
 * Dashboard origin with swarm_config precedence (`APP_URL`, then the
 * deprecated `DASHBOARD_URL`). Both accept a comma-separated list; the first
 * entry wins, matching `getAppUrl`. Returns null when neither is set, so
 * callers can omit it instead of guessing the hosted default.
 */
export async function resolveAppUrl(): Promise<string | null> {
  const configured =
    (await resolveConfigValue("APP_URL")) ?? (await resolveConfigValue("DASHBOARD_URL"));
  const first = configured
    ?.split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .find(Boolean);
  return first || null;
}
