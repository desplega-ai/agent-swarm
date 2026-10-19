import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDbClient, upsertSwarmConfig } from "../be/db";
import {
  buildListing,
  mintRankingClaim,
  PUBLIC_RANKING_ENABLED_KEY,
  RANKING_CATEGORIES,
  rankingEntryFile,
  rankingFormSchema,
  rankingLeaveUrl,
  rankingPrUrl,
  readTelemetryRanking,
  TELEMETRY_RANKING_KEY,
  type TelemetryRanking,
} from "../ranking/telemetry-ranking";
import { isTelemetryEnabled, telemetry } from "../telemetry";
import { isEnvFlagEnabled } from "../utils/env-flag";
import {
  ORG_IDENTITY_KEYS,
  type OrgIdentityStatus,
  orgIdentityStatus,
} from "../utils/org-identity";
import { ensureConfigAdmin } from "./config";
import { scheduleIntegrationsReload } from "./core";
import { route } from "./route-def";
import { globalConfig, telemetryProxyEndpoint } from "./used-by";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ListingSchema = z.object({
  v: z.literal(1),
  claim: z.string(),
  name: z.string(),
  domain: z.string(),
  category: z.enum(RANKING_CATEGORIES),
  subcategory: z.string().nullable(),
  description: z.string().nullable(),
  sourceCodeUrl: z.string().nullable(),
  updatedAt: z.string(),
});

const RankingStateSchema = z.object({
  eligible: z.boolean(),
  missing: z.array(z.enum(ORG_IDENTITY_KEYS)),
  telemetryOn: z.boolean(),
  enabled: z.boolean(),
  /** The org identity the listing would copy. */
  name: z.string().nullable(),
  domain: z.string().nullable(),
  listing: ListingSchema.nullable(),
  /** False when the stored listing was built for another website: a new PR is needed. */
  listingMatchesDomain: z.boolean(),
  fileJson: z.string().nullable(),
  prUrl: z.string().nullable(),
  verifyUrl: z.string().nullable(),
});
export type RankingState = z.infer<typeof RankingStateSchema>;

const OptInResponseSchema = z.object({
  domain: z.string(),
  claim: z.string(),
  listing: ListingSchema,
  fileJson: z.string(),
  prUrl: z.string(),
  verifyUrl: z.string(),
});

const OptOutResponseSchema = z.object({
  enabled: z.literal(false),
  leaveUrl: z.string().nullable(),
});

// ─── Route Definitions ───────────────────────────────────────────────────────

const getRanking = route({
  method: "get",
  path: "/api/ranking",
  pattern: ["api", "ranking"],
  summary: "Public ranking state",
  description:
    "Whether this install can join the public agent-swarm.dev ranking (telemetry on, organization name and website set), whether it is opted in, and its stored listing. The listing carries the private ranking claim, so only a config admin can read it.",
  tags: ["Telemetry"],
  responses: {
    200: { description: "Ranking state", schema: RankingStateSchema },
    401: { description: "Unauthorized" },
    403: { description: "Only a config admin can read the ranking state" },
  },
  rbac: { permission: "config.write.any" },
});

const optIn = route({
  method: "post",
  path: "/api/ranking/opt-in",
  pattern: ["api", "ranking", "opt-in"],
  summary: "Opt this install into the public ranking",
  description:
    "Builds the telemetry_ranking listing from the organization name and website plus the chosen category, stores it, turns PUBLIC_RANKING_ENABLED on and sends ranking.opted_in. The install is ranked only after a ranking PR with the returned file is merged into desplega-ai/agent-swarm.",
  tags: ["Telemetry"],
  body: rankingFormSchema,
  responses: {
    200: { description: "Opted in", schema: OptInResponseSchema },
    400: { description: "A listing field is invalid" },
    401: { description: "Unauthorized" },
    403: { description: "Only a config admin can opt in" },
    409: {
      description:
        "telemetry_off: telemetry is off or the install has no ID. org_identity_missing: the organization name or website is not set (`missing` lists which).",
    },
  },
  rbac: { permission: "config.write.any" },
});

const optOut = route({
  method: "post",
  path: "/api/ranking/opt-out",
  pattern: ["api", "ranking", "opt-out"],
  summary: "Leave the public ranking",
  description:
    "Turns PUBLIC_RANKING_ENABLED off and sends ranking.opted_out, so workers stop sending ranking.usage. Returns the GitHub page that deletes the ranking entry.",
  tags: ["Telemetry"],
  responses: {
    200: { description: "Opted out", schema: OptOutResponseSchema },
    401: { description: "Unauthorized" },
    403: { description: "Only a config admin can opt out" },
  },
  rbac: { permission: "config.write.any" },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RANKING_CONFIG_KEYS = new Set<string>([...ORG_IDENTITY_KEYS, PUBLIC_RANKING_ENABLED_KEY]);

/**
 * The org identity from global config. `changed` carries a value just written
 * or deleted, since `globalConfig` falls back to `process.env`, which the
 * debounced reload has not updated yet.
 */
async function currentIdentity(changed?: {
  key: string;
  value: string | null;
}): Promise<OrgIdentityStatus> {
  const read = async (key: string) =>
    changed?.key === key ? changed.value : await globalConfig(key);
  return orgIdentityStatus({
    SWARM_ORG_NAME: await read("SWARM_ORG_NAME"),
    SWARM_ORG_WEBSITE: await read("SWARM_ORG_WEBSITE"),
  });
}

async function storedListing(): Promise<TelemetryRanking | null> {
  return readTelemetryRanking(await globalConfig(TELEMETRY_RANKING_KEY));
}

async function rankingEnabled(): Promise<boolean> {
  const raw = await globalConfig(PUBLIC_RANKING_ENABLED_KEY);
  return isEnvFlagEnabled(PUBLIC_RANKING_ENABLED_KEY, false, {
    [PUBLIC_RANKING_ENABLED_KEY]: raw,
  });
}

async function telemetryReady(): Promise<boolean> {
  return isTelemetryEnabled() && Boolean(await globalConfig("telemetry_installation_id"));
}

async function verifyUrl(listing: Pick<TelemetryRanking, "domain" | "claim">): Promise<string> {
  const params = new URLSearchParams({ domain: listing.domain, claim: listing.claim });
  return `${await telemetryProxyEndpoint("/v1/ranking/verify")}?${params.toString()}`;
}

async function setEnabled(enabled: boolean): Promise<void> {
  await upsertSwarmConfig({
    scope: "global",
    key: PUBLIC_RANKING_ENABLED_KEY,
    value: String(enabled),
  });
}

function emitOptedIn(listing: TelemetryRanking): void {
  telemetry.ranking(
    "opted_in",
    { listing: JSON.stringify(listing) },
    { orgName: listing.name, orgWebsite: listing.domain },
  );
}

function emitOptedOut(domain: string): void {
  telemetry.ranking("opted_out", { domain });
}

export async function buildRankingState(): Promise<RankingState> {
  const [identity, listing, enabled, telemetryOn] = await Promise.all([
    currentIdentity(),
    storedListing(),
    rankingEnabled(),
    telemetryReady(),
  ]);
  const listingMatchesDomain = Boolean(listing && listing.domain === identity.website);
  const current = listingMatchesDomain ? listing : null;
  return {
    eligible: telemetryOn && identity.ok,
    missing: identity.missing,
    telemetryOn,
    enabled: enabled && listingMatchesDomain,
    name: identity.name,
    domain: identity.website,
    listing,
    listingMatchesDomain,
    fileJson: current ? rankingEntryFile(current) : null,
    prUrl: current ? rankingPrUrl(current) : null,
    verifyUrl: current ? await verifyUrl(current) : null,
  };
}

/**
 * Keep the listing in step with the org identity after a global config write.
 * A renamed org rebuilds the listing with the same claim and re-sends it; a
 * cleared or placeholder name, a changed or cleared website, or the setting
 * turned off by hand opts the install out.
 */
export async function syncRankingAfterConfigChange(
  key: string,
  value: string | null,
): Promise<void> {
  if (!RANKING_CONFIG_KEYS.has(key)) return;
  const listing = await storedListing();
  if (!listing) return;
  if (key === PUBLIC_RANKING_ENABLED_KEY) {
    if (!isEnvFlagEnabled(key, false, { [key]: value ?? undefined })) {
      emitOptedOut(listing.domain);
    }
    return;
  }
  if (!(await rankingEnabled())) return;

  const identity = await currentIdentity({ key, value });
  let rebuilt: TelemetryRanking | null = null;
  if (identity.ok && identity.website === listing.domain) {
    if (identity.name === listing.name) return;
    try {
      rebuilt = buildListing(identity, listing, listing.claim);
    } catch {
      // A name the listing cannot carry (over 60 characters) leaves the ranking.
    }
  }
  if (!rebuilt) {
    await setEnabled(false);
    emitOptedOut(listing.domain);
    return;
  }
  await upsertSwarmConfig({
    scope: "global",
    key: TELEMETRY_RANKING_KEY,
    value: JSON.stringify(rebuilt),
  });
  emitOptedIn(rebuilt);
}

function conflict(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(409, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleRanking(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getRanking.match(req.method, pathSegments)) {
    const parsed = await getRanking.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    // The state carries the claim and the PR that proves ownership of the listing.
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
    getRanking.respond(res, 200, await buildRankingState());
    return true;
  }

  if (optIn.match(req.method, pathSegments)) {
    const parsed = await optIn.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;

    if (!(await telemetryReady())) {
      conflict(res, {
        error: "telemetry_off",
        message: "Turn telemetry on first: the ranking counts tokens from telemetry.",
      });
      return true;
    }
    const identity = await currentIdentity();
    if (!identity.ok || !identity.website) {
      conflict(res, {
        error: "org_identity_missing",
        message: "Set the organization name and website first",
        missing: identity.missing,
      });
      return true;
    }

    const website = identity.website;
    const db = getDbClient();
    // Read the stored claim under the write lock: two concurrent first opt-ins
    // must return the same claim, or the one merged into community/ranking is lost.
    const built = await db.transaction(async () => {
      const stored = await storedListing();
      const claim = stored?.domain === website ? stored.claim : mintRankingClaim();
      let listing: TelemetryRanking;
      try {
        listing = buildListing(identity, parsed.body, claim);
      } catch (error) {
        return { ok: false as const, error };
      }
      await upsertSwarmConfig({
        scope: "global",
        key: TELEMETRY_RANKING_KEY,
        value: JSON.stringify(listing),
      });
      await setEnabled(true);
      db.afterCommit(() => emitOptedIn(listing));
      return { ok: true as const, listing };
    });
    if (!built.ok) {
      const issue = built.error instanceof z.ZodError ? built.error.issues[0] : undefined;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: issue
            ? `Invalid ${issue.path.join(".") || "listing"}: ${issue.message}`
            : "Invalid listing",
        }),
      );
      return true;
    }
    const { listing } = built;
    scheduleIntegrationsReload();

    optIn.respond(res, 200, {
      domain: listing.domain,
      claim: listing.claim,
      listing,
      fileJson: rankingEntryFile(listing),
      prUrl: rankingPrUrl(listing),
      verifyUrl: await verifyUrl(listing),
    });
    return true;
  }

  if (optOut.match(req.method, pathSegments)) {
    const parsed = await optOut.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
    const listing = await storedListing();
    await setEnabled(false);
    if (listing) emitOptedOut(listing.domain);
    scheduleIntegrationsReload();
    optOut.respond(res, 200, {
      enabled: false,
      leaveUrl: listing ? rankingLeaveUrl(listing.domain) : null,
    });
    return true;
  }

  return false;
}
