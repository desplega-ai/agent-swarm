import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDbClient, upsertSwarmConfig } from "../be/db";
import { isTelemetryEnabled, trackRelayed } from "../telemetry";
import { reportedUserFunction, USER_FUNCTIONS } from "../utils/company-profile";
import { orgIdentityStatus } from "../utils/org-identity";
import { normalizeOrgWebsite, TELEMETRY_PROXY_ORIGIN } from "../utils/org-website";
import { ensureConfigAdmin } from "./config";
import { scheduleIntegrationsReload } from "./core";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { globalConfig } from "./global-config";
import { route } from "./route-def";
import { jsonError } from "./utils";

const CONSENT_KEY = "SWARM_USED_BY_CONSENT";
const CONSENT_AT_KEY = "SWARM_USED_BY_CONSENT_AT";
// The identity sent with the last accepted grant: a revoke reuses it, so it
// still reaches the proxy after the name or website is changed or cleared.
const GRANTED_NAME_KEY = "SWARM_USED_BY_ORG_NAME";
const GRANTED_WEBSITE_KEY = "SWARM_USED_BY_ORG_WEBSITE";
const CONTACT_EMAIL_KEY = "SWARM_USED_BY_CONTACT_EMAIL";
const CONTACT_FUNCTION_KEY = "SWARM_USED_BY_CONTACT_FUNCTION";
const QUOTE_KEY = "SWARM_USED_BY_QUOTE";
const TIMEOUT_MS = 10_000;

// ─── Route Definitions ───────────────────────────────────────────────────────

const usedBy = route({
  method: "post",
  path: "/api/used-by",
  pattern: ["api", "used-by"],
  summary: "Grant or revoke the 'used by' logo consent",
  description:
    "Records consent to show the organization's logo on agent-swarm.dev. A grant requires a valid contact email. It sends organization identity, contact details, and an optional quote to the proxy for manual review. This explicit admin action works when telemetry is off. A revoke clears the stored contact details and quote.",
  tags: ["Telemetry"],
  body: z
    .object({
      granted: z.boolean(),
      contactEmail: z
        .string()
        .max(320, "Contact email must be at most 320 characters")
        .email("Contact email must be a valid email address")
        .optional(),
      contactFunction: z.enum(USER_FUNCTIONS).optional(),
      quote: z.string().max(280).optional(),
    })
    .refine((body) => !body.granted || body.contactEmail !== undefined, {
      path: ["contactEmail"],
      message: "Contact email is required when granting logo consent",
    }),
  responses: {
    200: {
      description: "Consent recorded",
      schema: z.object({ granted: z.boolean(), changedAt: z.string() }),
    },
    400: {
      description: "Invalid contact details, or missing organization name or website",
    },
    401: { description: "Unauthorized" },
    403: { description: "Only a config admin can change the consent" },
    502: { description: "The telemetry proxy did not accept the consent" },
  },
  rbac: { permission: "config.write.any" },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

  const { granted, contactEmail, contactFunction, quote } = parsed.body;
  // The shared identity reader. The grant keeps its own rule (any non-empty
  // name), so it does not apply the ranking's placeholder-name check.
  const current = orgIdentityStatus({
    SWARM_ORG_NAME: await globalConfig("SWARM_ORG_NAME"),
    SWARM_ORG_WEBSITE: await globalConfig("SWARM_ORG_WEBSITE"),
  });
  const currentName = current.name ?? undefined;
  const currentWebsite = current.website;
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
        ...(granted
          ? {
              contact_email: contactEmail,
              // The proxy rejects a job function its catalog does not list yet.
              contact_function: reportedUserFunction(contactFunction),
              quote,
            }
          : {}),
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

  await getDbClient().transaction(async () => {
    await upsertSwarmConfig({ scope: "global", key: CONSENT_KEY, value: String(granted) });
    await upsertSwarmConfig({ scope: "global", key: CONSENT_AT_KEY, value: changedAt });
    if (granted) {
      await upsertSwarmConfig({ scope: "global", key: GRANTED_NAME_KEY, value: orgName });
      await upsertSwarmConfig({ scope: "global", key: GRANTED_WEBSITE_KEY, value: orgWebsite });
    }
    // Contact details stay out of agent env. The email is also a secret row,
    // so `GET /api/config` masks it for every reader.
    for (const [key, value, isSecret] of [
      [CONTACT_EMAIL_KEY, contactEmail, true],
      [CONTACT_FUNCTION_KEY, contactFunction, false],
      [QUOTE_KEY, quote, false],
    ] as const) {
      await upsertSwarmConfig({
        scope: "global",
        key,
        value: granted ? (value ?? "") : "",
        isSecret,
        exportToEnv: false,
      });
    }
  });
  scheduleIntegrationsReload();

  const owner = await resolveHttpFavoriteOwner(req, myAgentId);
  trackRelayed(
    "used_by.consent_changed",
    {
      granted,
      has_quote: granted && Boolean(quote),
      has_function: granted && Boolean(contactFunction),
    },
    { actor: owner?.userId ? { userId: owner.userId } : undefined, emitter: "ui" },
  );
  usedBy.respond(res, 200, { granted, changedAt });
  return true;
}
