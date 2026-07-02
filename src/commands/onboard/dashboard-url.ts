/**
 * Build the swarm-dashboard deep-link the SPA reads after a local onboard.
 *
 * IMPORTANT: the dashboard SPA reads **camelCase** `apiUrl` / `apiKey` query
 * params (see apps/ui/src/hooks/use-config.ts → extractUrlParams) and silently
 * ignores snake_case. An earlier version of these builders emitted snake_case
 * `api_url` / `api_key`, so the auto-connect deep-link never worked. Keep these
 * camelCase.
 */

const DEFAULT_DASHBOARD_BASE = "https://app.agent-swarm.dev";

export type DashboardUrlParts = {
  apiUrl: string;
  apiKey?: string;
  /** Optional connection name shown in the dashboard (camelCase `name`). */
  name?: string;
  /** Override the dashboard base (defaults to the production app). */
  base?: string;
};

export function buildOnboardDashboardUrl(parts: DashboardUrlParts): string {
  const params = new URLSearchParams();
  params.set("apiUrl", parts.apiUrl);
  if (parts.apiKey) params.set("apiKey", parts.apiKey);
  if (parts.name) params.set("name", parts.name);
  const base = (parts.base ?? DEFAULT_DASHBOARD_BASE).replace(/\/+$/, "");
  return `${base}?${params.toString()}`;
}
