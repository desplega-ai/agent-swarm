import { isFilledOrgLogoUrl, normalizeOrgWebsite, orgLogoUrl } from "../utils/org-website";
import { getSwarmConfigs, upsertSwarmConfig } from "./db";

const LOGO_KEY = "SWARM_ORG_LOGO_URL";
// The logo URL this function last wrote. A logo is ours only while it still
// equals this value, so a person who sets any URL, even a proxy one, keeps it.
const FILLED_LOGO_KEY = "SWARM_ORG_LOGO_FILLED_URL";

async function globalValue(key: string): Promise<string> {
  const stored = (await getSwarmConfigs({ scope: "global", key }))?.[0]?.value?.trim();
  return stored || process.env[key]?.trim() || "";
}

/**
 * After `SWARM_ORG_WEBSITE` is saved, point `SWARM_ORG_LOGO_URL` at the
 * telemetry proxy's logo for that website, so the dashboard is org-branded.
 * Never overwrites a logo a person set: only an empty logo, or one this
 * function filled for an earlier website, is replaced. Returns whether it wrote.
 */
export async function fillOrgLogoFromWebsite(website: string): Promise<boolean> {
  const host = normalizeOrgWebsite(website);
  if (!host) return false;
  const current = await globalValue(LOGO_KEY);
  if (
    current &&
    !(isFilledOrgLogoUrl(current) && current === (await globalValue(FILLED_LOGO_KEY)))
  ) {
    return false;
  }
  const next = orgLogoUrl(host);
  if (current === next) return false;
  await upsertSwarmConfig({ scope: "global", key: LOGO_KEY, value: next, isSecret: false });
  await upsertSwarmConfig({ scope: "global", key: FILLED_LOGO_KEY, value: next, isSecret: false });
  return true;
}
