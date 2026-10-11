import { isFilledOrgLogoUrl, normalizeOrgWebsite, orgLogoUrl } from "../utils/org-website";
import { getSwarmConfigs, upsertSwarmConfig } from "./db";

const LOGO_KEY = "SWARM_ORG_LOGO_URL";

/**
 * After `SWARM_ORG_WEBSITE` is saved, point `SWARM_ORG_LOGO_URL` at the
 * telemetry proxy's logo for that website, so the dashboard is org-branded.
 * Never overwrites a logo a person set: only an empty logo, or one this
 * function filled for an earlier website, is replaced. Returns whether it wrote.
 */
export async function fillOrgLogoFromWebsite(website: string): Promise<boolean> {
  const host = normalizeOrgWebsite(website);
  if (!host) return false;
  const stored = (await getSwarmConfigs({ scope: "global", key: LOGO_KEY }))?.[0]?.value?.trim();
  const current = stored || process.env[LOGO_KEY]?.trim() || "";
  if (current && !isFilledOrgLogoUrl(current)) return false;
  const next = orgLogoUrl(host);
  if (current === next) return false;
  await upsertSwarmConfig({ scope: "global", key: LOGO_KEY, value: next, isSecret: false });
  return true;
}
