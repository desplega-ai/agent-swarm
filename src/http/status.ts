/**
 * `/status` — identity + setup readiness + activity + agent_fs aggregate
 * for the home page.
 *
 * Phase 1 of the cloud-personalization plan. The route is the single source
 * of truth for "what does this swarm look like / what's set up / what's
 * missing" so the UI's `HomePage` (and later phases' header badge / smart
 * empty states) can lean on one contract.
 *
 * Design notes:
 * - Setup checks are env- and DB-only (zero network, zero side effects).
 *   Live upstream calls happen only via `POST /status/test-connection`,
 *   which then caches a `verifiedAt` timestamp per provider in-memory.
 * - The cache is intentionally in-memory: it's a UX nicety, not durable
 *   state. Lost on restart by design — operators re-click the button to
 *   reverify. Future iteration can persist `last_verified_at` per provider
 *   in `swarm_config` if this proves annoying (no migration needed).
 * - Provider env reads come from `process.env` directly so the route
 *   reflects whatever `loadGlobalConfigsAndIntegrations` last injected.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb, getInstanceActivity, getLiveAgentCounts, hasFirstCompletedTask } from "../be/db";
import { getOAuthApp, getOAuthTokens } from "../be/db-queries/oauth";
import { checkProviderCredentials, validateProviderCredentials } from "../providers/credentials";
import { ProviderNameSchema } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const SetupMilestoneStateSchema = z.enum(["unverified", "configured", "verified"]);
export type SetupMilestoneState = z.infer<typeof SetupMilestoneStateSchema>;

export const SetupMilestoneIdSchema = z.enum([
  "harness",
  "slack",
  "github",
  "linear",
  "jira",
  "workers",
  "first_task",
]);
export type SetupMilestoneId = z.infer<typeof SetupMilestoneIdSchema>;

export const SetupMilestoneSchema = z.object({
  id: SetupMilestoneIdSchema,
  label: z.string(),
  state: SetupMilestoneStateSchema,
  hint: z.string().optional(),
  action_url: z.string().optional(),
  /**
   * Canonical harness provider name. Only populated on the `harness`
   * milestone when `process.env.HARNESS_PROVIDER` is a known canonical
   * provider. The UI uses this directly (no hint-string regex).
   */
  provider: ProviderNameSchema.optional(),
});
export type SetupMilestone = z.infer<typeof SetupMilestoneSchema>;

export const StatusIdentitySchema = z.object({
  name: z.string(),
  logo_url: z.string().nullable(),
  brand_color: z.string().nullable(),
  is_cloud: z.boolean(),
  marketing_url: z.string().nullable(),
  hide_cloud_promo: z.boolean(),
});
export type StatusIdentity = z.infer<typeof StatusIdentitySchema>;

export const StatusActivitySchema = z.object({
  agents_online: z.number().int().nonnegative(),
  leads_online: z.number().int().nonnegative(),
  recent_tasks_count: z.number().int().nonnegative(),
});
export type StatusActivity = z.infer<typeof StatusActivitySchema>;

export const StatusAgentFsSchema = z.object({
  configured: z.boolean(),
  base_url: z.string().nullable(),
});
export type StatusAgentFs = z.infer<typeof StatusAgentFsSchema>;

/**
 * Phase 2: Aggregate health derived from setup milestones.
 *
 * - `broken`  — harness or workers blocking (creds missing, no live workers ever).
 * - `degraded` — at least one optional integration `unverified`/`configured`
 *                 while another is configured, OR harness creds present but
 *                 never tested (`configured`).
 * - `ok`       — harness + workers `verified`; no integration left in
 *                 `configured` state.
 */
export const StatusHealthSchema = z.enum(["ok", "degraded", "broken"]);
export type StatusHealth = z.infer<typeof StatusHealthSchema>;

export const StatusResponseSchema = z.object({
  identity: StatusIdentitySchema,
  setup: z.array(SetupMilestoneSchema),
  activity: StatusActivitySchema,
  agent_fs: StatusAgentFsSchema,
  /** Phase 2: rolled-up health for the always-on header badge. */
  health: StatusHealthSchema,
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const TestConnectionRequestSchema = z.object({
  provider: ProviderNameSchema,
});

export const TestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  latency_ms: z.number().int().nonnegative(),
});

// ─── Test-connection cache (in-memory) ───────────────────────────────────────

interface TestCacheEntry {
  ok: boolean;
  verifiedAt: number;
}

const testConnectionCache = new Map<string, TestCacheEntry>();

function getVerifyTtlMs(): number {
  const raw = process.env.SWARM_VERIFY_TTL_MS;
  if (!raw) return 3_600_000; // 1h default
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 3_600_000;
  return parsed;
}

function isCachedVerified(provider: string): boolean {
  const entry = testConnectionCache.get(provider);
  if (!entry) return false;
  if (!entry.ok) return false;
  const ttl = getVerifyTtlMs();
  return entry.verifiedAt + ttl > Date.now();
}

/** Exported for tests. */
export function _resetTestConnectionCache(): void {
  testConnectionCache.clear();
}

// ─── Identity ────────────────────────────────────────────────────────────────

function buildIdentity(): StatusIdentity {
  const cloudRaw = process.env.SWARM_CLOUD;
  const hideRaw = process.env.SWARM_HIDE_CLOUD_PROMO;
  return {
    name: process.env.SWARM_ORG_NAME?.trim() || "Swarm",
    logo_url: process.env.SWARM_ORG_LOGO_URL?.trim() || null,
    brand_color: process.env.SWARM_BRAND_COLOR?.trim() || null,
    is_cloud: cloudRaw === "true" || cloudRaw === "1",
    marketing_url: process.env.SWARM_MARKETING_URL?.trim() || null,
    hide_cloud_promo: hideRaw === "true" || hideRaw === "1",
  };
}

// ─── Setup milestones ────────────────────────────────────────────────────────

function harnessMilestone(): SetupMilestone {
  const providerRaw = process.env.HARNESS_PROVIDER?.trim();
  if (!providerRaw) {
    return {
      id: "harness",
      label: "Harness configured",
      state: "unverified",
      hint: "Set a harness provider and the matching credentials (e.g. claude + ANTHROPIC_API_KEY).",
      action_url: "/integrations",
    };
  }

  // Only emit `provider` on the milestone when the env value is a canonical
  // provider name. Unknown values still flow through the rest of the logic
  // (so `unverified` is reported), but the UI doesn't get a bogus name.
  const parsed = ProviderNameSchema.safeParse(providerRaw);
  const providerName = parsed.success ? parsed.data : undefined;

  let credsReady = false;
  try {
    const creds = checkProviderCredentials(providerRaw, process.env);
    credsReady = creds.ready;
  } catch {
    // Unknown provider — treat as unverified, no creds.
    credsReady = false;
  }

  if (!credsReady) {
    return {
      id: "harness",
      label: "Harness configured",
      state: "unverified",
      hint: providerName
        ? "Harness provider is set but credentials are missing."
        : `Unknown harness provider "${providerRaw}". Use one of: claude, codex, pi, devin, claude-managed, opencode.`,
      action_url: "/integrations",
      ...(providerName ? { provider: providerName } : {}),
    };
  }

  if (isCachedVerified(providerRaw)) {
    return {
      id: "harness",
      label: "Harness configured",
      state: "verified",
      hint: "Live test passed within the last hour.",
      action_url: "/integrations",
      ...(providerName ? { provider: providerName } : {}),
    };
  }

  return {
    id: "harness",
    label: "Harness configured",
    state: "configured",
    hint: 'Credentials present — click "Test connection" to verify.',
    action_url: "/integrations",
    ...(providerName ? { provider: providerName } : {}),
  };
}

function slackMilestone(): SetupMilestone {
  const bot = process.env.SLACK_BOT_TOKEN;
  const app = process.env.SLACK_APP_TOKEN;
  const disable = process.env.SLACK_DISABLE;
  const disabled = disable === "true" || disable === "1";

  if (disabled || !bot || !app) {
    return {
      id: "slack",
      label: "Slack connected",
      state: "unverified",
      hint: disabled
        ? "Slack is explicitly disabled (SLACK_DISABLE=true)."
        : "Set SLACK_BOT_TOKEN + SLACK_APP_TOKEN to connect Slack.",
      action_url: "/integrations/slack",
    };
  }
  // Socket Mode connection state isn't surfaced today — Phase 2+ enhancement.
  // For now treat env-present as `verified` so the UX matches the brainstorm.
  return {
    id: "slack",
    label: "Slack connected",
    state: "verified",
    action_url: "/integrations/slack",
  };
}

function githubMilestone(): SetupMilestone {
  const webhook = process.env.GITHUB_WEBHOOK_SECRET;
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!webhook || !appId || !privateKey) {
    return {
      id: "github",
      label: "GitHub App connected",
      state: "unverified",
      hint: "Set GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY.",
      action_url: "/integrations/github",
    };
  }
  return {
    id: "github",
    label: "GitHub App connected",
    state: "verified",
    action_url: "/integrations/github",
  };
}

function linearMilestone(): SetupMilestone {
  const tokens = getOAuthTokens("linear");
  if (!tokens) {
    return {
      id: "linear",
      label: "Linear connected",
      state: "unverified",
      hint: "Connect Linear via the integrations page.",
      action_url: "/integrations/linear",
    };
  }
  return {
    id: "linear",
    label: "Linear connected",
    state: "verified",
    hint: "Token row present; refresh-failure tracking will land in a future migration — check #swarm-alerts for keepalive errors.",
    action_url: "/integrations/linear",
  };
}

function jiraMilestone(): SetupMilestone {
  const tokens = getOAuthTokens("jira");
  if (!tokens) {
    return {
      id: "jira",
      label: "Jira connected",
      state: "unverified",
      hint: "Connect Jira via the integrations page.",
      action_url: "/integrations/jira",
    };
  }
  // Verify cloudId is in oauth_apps.metadata.
  const app = getOAuthApp("jira");
  let hasCloudId = false;
  try {
    const meta = app?.metadata ? JSON.parse(app.metadata) : null;
    hasCloudId = !!(meta && typeof meta === "object" && meta.cloudId);
  } catch {
    hasCloudId = false;
  }
  if (!hasCloudId) {
    return {
      id: "jira",
      label: "Jira connected",
      state: "unverified",
      hint: "Token row present, but cloudId is not yet stored — finish the Jira OAuth callback.",
      action_url: "/integrations/jira",
    };
  }
  return {
    id: "jira",
    label: "Jira connected",
    state: "verified",
    hint: "Token row present; refresh-failure tracking will land in a future migration — check #swarm-alerts for keepalive errors.",
    action_url: "/integrations/jira",
  };
}

function workersMilestone(): SetupMilestone {
  // `configured` if ≥1 row in agents; `verified` if both lead+worker alive
  // within the last 5 minutes.
  const totalRow = getDb()
    .prepare<{ count: number }, []>(`SELECT COUNT(*) AS count FROM agents`)
    .get();
  const totalAgents = totalRow?.count ?? 0;

  const { leads_alive, workers_alive } = getLiveAgentCounts(5);
  if (leads_alive > 0 && workers_alive > 0) {
    return {
      id: "workers",
      label: "Workers running",
      state: "verified",
      action_url: "/agents",
    };
  }

  if (totalAgents > 0) {
    return {
      id: "workers",
      label: "Workers running",
      state: "configured",
      hint:
        leads_alive === 0
          ? "Lead has no recent heartbeat — start the lead."
          : "No workers heartbeated in the last 5 minutes — start a worker.",
      action_url: "/agents",
    };
  }

  return {
    id: "workers",
    label: "Workers running",
    state: "unverified",
    hint: "Run a worker container via Docker compose. See docs for setup.",
    action_url: "/agents",
  };
}

function firstTaskMilestone(): SetupMilestone {
  if (hasFirstCompletedTask()) {
    return {
      id: "first_task",
      label: "First task completed",
      state: "verified",
      action_url: "/tasks",
    };
  }
  return {
    id: "first_task",
    label: "First task completed",
    state: "unverified",
    hint: "Send your first task to confirm the swarm runs end-to-end.",
    action_url: "/tasks?new=true",
  };
}

function buildSetup(): SetupMilestone[] {
  return [
    harnessMilestone(),
    slackMilestone(),
    githubMilestone(),
    linearMilestone(),
    jiraMilestone(),
    workersMilestone(),
    firstTaskMilestone(),
  ];
}

// ─── Health aggregate (Phase 2) ──────────────────────────────────────────────

/**
 * Roll the 7-milestone setup state into a single tri-state health value.
 *
 * Decision matrix:
 * - Harness `unverified` (no creds at all) → `broken` — the swarm cannot run a task.
 * - Workers `unverified` (no agents ever) → `broken` — same reason.
 * - Harness `configured` (creds present, never live-tested) → `degraded`.
 * - Workers `configured` (agents exist but no recent heartbeat) → `degraded`.
 * - Any of {slack, github, linear, jira} `configured` (i.e. half-set-up) → `degraded`.
 * - Otherwise → `ok`.
 *
 * Note: integrations in `unverified` are NOT degrading on their own — most
 * deployments don't connect every integration. They only nudge the rollup if
 * paired with another integration in `configured` (the brainstorm contract).
 */
export function computeHealth(setup: SetupMilestone[]): StatusHealth {
  const byId = new Map(setup.map((m) => [m.id, m] as const));
  const harness = byId.get("harness");
  const workers = byId.get("workers");

  // `broken` rules — critical blockers.
  if (!harness || harness.state === "unverified") return "broken";
  if (!workers || workers.state === "unverified") return "broken";

  // `degraded` rules.
  if (harness.state === "configured") return "degraded";
  if (workers.state === "configured") return "degraded";

  for (const id of ["slack", "github", "linear", "jira"] as const) {
    const m = byId.get(id);
    if (m?.state === "configured") return "degraded";
  }

  return "ok";
}

// ─── Public payload builder (also exported for tests) ────────────────────────

export function buildStatusPayload(): StatusResponse {
  const setup = buildSetup();
  return {
    identity: buildIdentity(),
    setup,
    activity: getInstanceActivity(),
    agent_fs: {
      configured: !!process.env.AGENT_FS_API_URL,
      base_url: process.env.AGENT_FS_API_URL ?? null,
    },
    health: computeHealth(setup),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const getStatus = route({
  method: "get",
  path: "/status",
  pattern: ["status"],
  summary: "Identity + setup readiness + live activity for the swarm dashboard",
  description:
    "Single source of truth consumed by the UI home page. Identity comes from SWARM_* envs; the 7 setup milestones each emit `unverified | configured | verified`; activity counts agents alive in the last 5 min and tasks created in the last 24h; agent_fs reports whether AGENT_FS_API_URL is set.",
  tags: ["Status"],
  responses: {
    200: { description: "Status payload", schema: StatusResponseSchema },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const postTestConnection = route({
  method: "post",
  path: "/status/test-connection",
  pattern: ["status", "test-connection"],
  summary: "Live-test the harness provider's credentials",
  description:
    "Issues a real upstream call (Anthropic /v1/models, OpenAI /v1/models, etc.) for the given provider. Updates an in-memory cache so the next GET /status reports `harness.state = 'verified'` for SWARM_VERIFY_TTL_MS (default 1h).",
  tags: ["Status"],
  body: TestConnectionRequestSchema,
  responses: {
    200: { description: "Live-test result", schema: TestConnectionResponseSchema },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleStatus(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getStatus.match(req.method, pathSegments)) {
    try {
      const payload = buildStatusPayload();
      json(res, payload);
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to build status", 500);
    }
    return true;
  }

  if (postTestConnection.match(req.method, pathSegments)) {
    const parsed = await postTestConnection.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { provider } = parsed.body;
    const result = await validateProviderCredentials(provider);
    if (result.ok) {
      testConnectionCache.set(provider, { ok: true, verifiedAt: Date.now() });
    } else {
      // Cache the failure too so the UI can render the latest result without
      // racing against a fresh GET. We only emit `verified` on `ok === true`
      // so a cached failure simply leaves the state at `configured`.
      testConnectionCache.set(provider, { ok: false, verifiedAt: Date.now() });
    }
    json(res, result);
    return true;
  }

  return false;
}
