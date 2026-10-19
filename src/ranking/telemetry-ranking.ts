/**
 * The `telemetry_ranking` listing: what an install opted into the public ranking
 * shows on agent-swarm.dev/ranking. Stored stringified in the global
 * `swarm_config` key `telemetry_ranking` and sent as the `listing` property of
 * `ranking.opted_in`.
 *
 * The proxy owns the contract (`src/telemetry-contract/ranking/`, vendored by
 * `bun run sync:telemetry-contract`). This schema and the proxy's Go decoder are
 * both held to its fixtures. Pure: imported by the API and the dashboard.
 */
import { z } from "zod";
import { RANKING_TAXONOMY } from "../telemetry-contract/ranking-taxonomy.gen";
import type { OrgIdentityStatus } from "../utils/org-identity";
import { normalizeOrgWebsite } from "../utils/org-website";

export { RANKING_TAXONOMY };

export const TELEMETRY_RANKING_KEY = "telemetry_ranking";
export const PUBLIC_RANKING_ENABLED_KEY = "PUBLIC_RANKING_ENABLED";
export const TELEMETRY_RANKING_MAX_BYTES = 2048;

export const RANKING_CATEGORIES = Object.keys(RANKING_TAXONOMY) as [
  keyof typeof RANKING_TAXONOMY,
  ...(keyof typeof RANKING_TAXONOMY)[],
];
const hostname = z.string().refine((v) => normalizeOrgWebsite(v) === v, "bare hostname");
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();

function inCategory(category: string, subcategory: string | null): boolean {
  if (subcategory === null) return true;
  const subs: readonly string[] = RANKING_TAXONOMY[category as keyof typeof RANKING_TAXONOMY];
  return subs?.includes(subcategory) ?? false;
}

export const telemetryRankingV1 = z
  .strictObject({
    v: z.literal(1),
    /** Minted by v2.4.0 for the retired ranking PR. Still parsed, never written; the proxy ignores it. */
    claim: z
      .string()
      .regex(/^rk_[0-9a-f]{32}$/)
      .optional(),
    name: z.string().trim().min(1).max(60),
    domain: hostname,
    category: z.enum(RANKING_CATEGORIES),
    subcategory: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(40)
      .nullable(),
    description: nullableText(160),
    sourceCodeUrl: z
      .url({ protocol: /^https$/ })
      .max(200)
      .nullable(),
    updatedAt: z.iso.datetime(),
  })
  .refine((l) => inCategory(l.category, l.subcategory), {
    path: ["subcategory"],
    message: "not in this category",
  });

/** Discriminated on `v`; a v2 is added here, never by editing v1. */
export const telemetryRankingSchema = z.discriminatedUnion("v", [telemetryRankingV1]);
export type TelemetryRanking = z.infer<typeof telemetryRankingSchema>;

export function parseTelemetryRanking(raw: string): TelemetryRanking {
  if (new TextEncoder().encode(raw).length > TELEMETRY_RANKING_MAX_BYTES) {
    throw new Error(`telemetry_ranking exceeds ${TELEMETRY_RANKING_MAX_BYTES} bytes`);
  }
  return telemetryRankingSchema.parse(JSON.parse(raw));
}

/** The stored listing, or null when it is missing or no longer valid. */
export function readTelemetryRanking(raw: string | null | undefined): TelemetryRanking | null {
  if (!raw?.trim()) return null;
  try {
    return parseTelemetryRanking(raw);
  } catch {
    return null;
  }
}

/** What the admin picks in the ranking form. Name and domain are never typed here. */
export const rankingFormSchema = z.object({
  category: z.enum(RANKING_CATEGORIES),
  subcategory: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  sourceCodeUrl: z.string().nullable().optional(),
});
export type RankingForm = z.infer<typeof rankingFormSchema>;

const blankToNull = (value: string | null | undefined) => value?.trim() || null;

/**
 * Build and validate the listing. Name and domain are copied from the org
 * identity (`SWARM_ORG_NAME`, `SWARM_ORG_WEBSITE`); throws when the identity is
 * not set or a form field breaks the contract.
 */
export function buildListing(
  identity: OrgIdentityStatus,
  form: RankingForm,
  now: Date = new Date(),
): TelemetryRanking {
  if (!identity.ok || !identity.name || !identity.website) {
    throw new Error(`Org identity is missing: ${identity.missing.join(", ")}`);
  }
  const listing = {
    v: 1 as const,
    name: identity.name,
    domain: identity.website,
    category: form.category,
    subcategory: blankToNull(form.subcategory),
    description: blankToNull(form.description),
    sourceCodeUrl: blankToNull(form.sourceCodeUrl),
    updatedAt: now.toISOString(),
  };
  return parseTelemetryRanking(JSON.stringify(listing));
}
