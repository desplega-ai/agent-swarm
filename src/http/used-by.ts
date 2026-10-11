import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getSwarmConfigs, upsertSwarmConfig } from "../be/db";
import { trackRelayed } from "../telemetry";
import { normalizeOrgWebsite, TELEMETRY_PROXY_ORIGIN } from "../utils/org-website";
import { ensureConfigAdmin } from "./config";
import { scheduleIntegrationsReload } from "./core";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { route } from "./route-def";
import { jsonError } from "./utils";

const CONSENT_KEY = "SWARM_USED_BY_CONSENT";
const CONSENT_AT_KEY = "SWARM_USED_BY_CONSENT_AT";
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
    400: { description: "Organization name or website is not set" },
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

/** `/v1/used-by` next to the configured `/v1/feedback` endpoint, so a stubbed proxy gets both. */
export async function usedByEndpoint(): Promise<string> {
  const feedback = await globalConfig("feedback_endpoint");
  if (feedback && /\/v1\/feedback\/?$/.test(feedback)) {
    return feedback.replace(/\/v1\/feedback\/?$/, "/v1/used-by");
  }
  return `${TELEMETRY_PROXY_ORIGIN}/v1/used-by`;
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
  const orgName = await globalConfig("SWARM_ORG_NAME");
  const orgWebsite = normalizeOrgWebsite(await globalConfig("SWARM_ORG_WEBSITE"));
  if (!orgName || !orgWebsite) {
    jsonError(res, "Set the organization name and website first", 400);
    return true;
  }
  const installId = await globalConfig("telemetry_installation_id");
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
