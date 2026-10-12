import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getSwarmConfigs, upsertSwarmConfig } from "../be/db";
import { isTelemetryEnabled, trackRelayed } from "../telemetry";
import { normalizeOrgWebsite, TELEMETRY_PROXY_ORIGIN } from "../utils/org-website";
import { ensureConfigAdmin } from "./config";
import { scheduleIntegrationsReload } from "./core";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { route } from "./route-def";
import { jsonError } from "./utils";

const CONSENT_KEY = "SWARM_USED_BY_CONSENT";
const CONSENT_AT_KEY = "SWARM_USED_BY_CONSENT_AT";
// The identity sent with the last accepted grant: a revoke reuses it, so it
// still reaches the proxy after the name or website is changed or cleared.
const GRANTED_NAME_KEY = "SWARM_USED_BY_ORG_NAME";
const GRANTED_WEBSITE_KEY = "SWARM_USED_BY_ORG_WEBSITE";
const TIMEOUT_MS = 10_000;

// ─── Route Definitions ───────────────────────────────────────────────────────

const usedBy = route({
  method: "post",
  path: "/api/used-by",
  pattern: ["api", "used-by"],
  summary: "Grant or revoke the 'used by' logo consent",
  description:
    "Records whether agent-swarm.dev may show this organization's logo as a company that uses Agent Swarm. Sends the organization name and website to the telemetry proxy, where a person approves each logo by hand. An explicit admin action, so it is not gated by the telemetry opt-out.",
  tags: ["Telemetry"],
  body: z.object({ granted: z.boolean() }),
  responses: {
    200: {
      description: "Consent recorded",
      schema: z.object({ granted: z.boolean(), changedAt: z.string() }),
    },
    400: {
      description:
        "Organization name or website is not set (a revoke falls back to the identity of the last grant)",
    },
    401: { description: "Unauthorized" },
    403: { description: "Only a config admin can change the consent" },
    502: { description: "The telemetry proxy did not accept the consent" },
  },
  rbac: { permission: "config.write.any" },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function globalConfig(key: string): Promise<string | undefined> {
  const stored = (await getSwarmConfigs({ scope: "global", key }))?.[0]?.value?.trim();
  return stored || process.env[key]?.trim() || undefined;
}

/** A proxy path next to the configured `/v1/feedback` endpoint, so a stubbed proxy gets every route. */
export async function telemetryProxyEndpoint(path: `/v1/${string}`): Promise<string> {
  const feedback = await globalConfig("feedback_endpoint");
  if (feedback && /^https?:\/\/[^/]+\/v1\/feedback\/?$/.test(feedback)) {
    return feedback.replace(/\/v1\/feedback\/?$/, path);
  }
  return `${TELEMETRY_PROXY_ORIGIN}${path}`;
}

export function usedByEndpoint(): Promise<string> {
  return telemetryProxyEndpoint("/v1/used-by");
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleUsedBy(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (!usedBy.match(req.method, pathSegments)) return false;
  const parsed = await usedBy.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;

  const { granted } = parsed.body;
  const currentName = await globalConfig("SWARM_ORG_NAME");
  const currentWebsite = normalizeOrgWebsite(await globalConfig("SWARM_ORG_WEBSITE"));
  const grantedName = granted ? undefined : await globalConfig(GRANTED_NAME_KEY);
  const grantedWebsite = granted
    ? null
    : normalizeOrgWebsite(await globalConfig(GRANTED_WEBSITE_KEY));
  const [orgName, orgWebsite] =
    grantedName && grantedWebsite ? [grantedName, grantedWebsite] : [currentName, currentWebsite];
  if (!orgName || !orgWebsite) {
    jsonError(res, "Set the organization name and website first", 400);
    return true;
  }
  // With telemetry off this sends only what the admin asked to share.
  const installId = isTelemetryEnabled()
    ? await globalConfig("telemetry_installation_id")
    : undefined;
  const orgDomain = await globalConfig("telemetry_org_domain");
  const changedAt = new Date().toISOString();

  try {
    const response = await fetch(await usedByEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(installId ? { install_id: installId } : {}),
        org_name: orgName,
        org_website: orgWebsite,
        ...(orgDomain ? { org_domain: orgDomain } : {}),
        granted,
        changed_at: changedAt,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      jsonError(res, `The telemetry proxy answered ${response.status}`, 502);
      return true;
    }
  } catch {
    jsonError(res, "Could not reach the telemetry proxy", 502);
    return true;
  }

  await upsertSwarmConfig({ scope: "global", key: CONSENT_KEY, value: String(granted) });
  await upsertSwarmConfig({ scope: "global", key: CONSENT_AT_KEY, value: changedAt });
  if (granted) {
    await upsertSwarmConfig({ scope: "global", key: GRANTED_NAME_KEY, value: orgName });
    await upsertSwarmConfig({ scope: "global", key: GRANTED_WEBSITE_KEY, value: orgWebsite });
  }
  scheduleIntegrationsReload();

  const owner = await resolveHttpFavoriteOwner(req, myAgentId);
  trackRelayed(
    "used_by.consent_changed",
    { granted },
    { actor: owner?.userId ? { userId: owner.userId } : undefined, emitter: "ui" },
  );
  usedBy.respond(res, 200, { granted, changedAt });
  return true;
}
