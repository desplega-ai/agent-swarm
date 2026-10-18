/**
 * The "is the org identity set" rule, shared by every feature that needs a real
 * organization name and website (the public ranking, the "used by" grant).
 * Pure: the API passes global config values, workers pass `process.env`.
 */
import { normalizeOrgWebsite } from "./org-website";

export const ORG_IDENTITY_KEYS = ["SWARM_ORG_NAME", "SWARM_ORG_WEBSITE"] as const;
export type OrgIdentityKey = (typeof ORG_IDENTITY_KEYS)[number];

/** Names the product falls back to when none is set; they are not an org name. */
const PLACEHOLDER_NAMES = new Set(["swarm", "your swarm"]);

export interface OrgIdentityStatus {
  /** The trimmed name, or null when blank. A placeholder is returned but listed as missing. */
  name: string | null;
  /** The website as a bare hostname, or null when blank or not a public hostname. */
  website: string | null;
  missing: OrgIdentityKey[];
  ok: boolean;
}

export function orgIdentityStatus(src: {
  SWARM_ORG_NAME?: string | null;
  SWARM_ORG_WEBSITE?: string | null;
}): OrgIdentityStatus {
  const name = src.SWARM_ORG_NAME?.trim() || null;
  const website = normalizeOrgWebsite(src.SWARM_ORG_WEBSITE) || null;
  const missing: OrgIdentityKey[] = [];
  if (!name || PLACEHOLDER_NAMES.has(name.toLowerCase())) missing.push("SWARM_ORG_NAME");
  if (!website) missing.push("SWARM_ORG_WEBSITE");
  return { name, website, missing, ok: missing.length === 0 };
}
