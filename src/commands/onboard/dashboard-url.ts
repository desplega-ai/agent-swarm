/**
 * Build the swarm-dashboard deep-link the SPA reads after a local onboard.
 *
 * IMPORTANT: the dashboard SPA reads **camelCase** `apiUrl` / `apiKey` query
 * params (see apps/ui/src/hooks/use-config.ts → extractUrlParams) and silently
 * ignores snake_case. An earlier version of these builders emitted snake_case
 * `api_url` / `api_key`, so the auto-connect deep-link never worked. Keep these
 * camelCase.
 */

import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_DASHBOARD_BASE = "https://app.agent-swarm.dev";
export const SETUP_URL_PATH = ".agent-swarm/setup-url";

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

/** Generated keys may not be in the scrubber's environment, or may be URL-encoded. */
export function maskDashboardUrlApiKey(url: string): string {
  return url.replace(/([?&]apiKey=)[^&#]*/g, "$1[REDACTED:apiKey]");
}

/** Save the credential-bearing link without exposing it to terminal output. */
export async function writeDashboardSetupUrl(outputDir: string, url: string): Promise<void> {
  const path = join(outputDir, SETUP_URL_PATH);
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  // A private temporary file plus rename also fixes permissions on an existing
  // file and replaces a symlink instead of writing through it.
  await mkdir(dirname(path), { recursive: true });
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await Bun.write(Bun.file(file.fd), `${url}\n`);
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } finally {
    await Bun.file(tmp)
      .delete()
      .catch(() => {});
  }
}
