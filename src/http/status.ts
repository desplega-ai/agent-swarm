/**
 * `/status` — identity + setup readiness + activity + agent_fs aggregate
 * for the home page.
 *
 * Architecture (post worker-self-report refactor):
 * - Credential checks are NEVER run server-side. Workers run them in their
 *   boot loop / post-task hook (`src/commands/credential-wait.ts` and
 *   `src/commands/runner.ts`) and POST results to the agent row's
 *   `cred_status` column. This file only reads those rows.
 * - This is critical for the bun-compiled API binary: importing any
 *   provider-adapter code at module level drags worker-harness SDKs (e.g.
 *   `@earendil-works/pi-coding-agent`) into the bundle, which crashes at
 *   `/usr/local/bin/` on boot. Keep this file adapter-free.
 * - Setup checks beyond credentials are still env- and DB-only (zero
 *   network, zero side effects).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  getAgentHarnessProviders,
  getDb,
  getInstanceActivity,
  getLiveAgentCounts,
  hasFirstCompletedTask,
  listAgentsWithCredStatusByProvider,
} from "../be/db";
import { getOAuthApp, getOAuthTokens } from "../be/db-queries/oauth";
import { getFileStorageProvider } from "../fs/registry";
import { type AgentCredStatus, ProviderNameSchema } from "../types";
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

/**
 * Per-provider rollup attached to the `harness` milestone when the swarm has
 * registered workers reporting `cred_status`. The milestone aggregates these
 * into a single state for `health` rollup, but the array lets the UI render
 * a per-provider breakdown (e.g. "claude verified · codex blocked").
 */
export const HarnessProviderRollupSchema = z.object({
  provider: ProviderNameSchema,
  state: SetupMilestoneStateSchema,
  workers: z.number().int().nonnegative(),
});
export type HarnessProviderRollup = z.infer<typeof HarnessProviderRollupSchema>;

export const SetupMilestoneSchema = z.object({
  id: SetupMilestoneIdSchema,
  label: z.string(),
  state: SetupMilestoneStateSchema,
  hint: z.string().optional(),
  action_url: z.string().optional(),
  /**
   * Canonical harness provider name. Only populated on the `harness`
   * milestone when the fleet contains exactly one distinct provider —
   * otherwise undefined and the UI falls back to `providers[]`.
   */
  provider: ProviderNameSchema.optional(),
  /**
   * Per-provider rollup. Populated on the `harness` milestone whenever the
   * fleet has ≥1 registered worker. Empty array possible if all rows have
   * `harness_provider = NULL` (legacy agents pre-migration 054).
   */
  providers: z.array(HarnessProviderRollupSchema).optional(),
});
export type SetupMilestone = z.infer<typeof SetupMilestoneSchema>;

export const StatusIdentitySchema = z.object({
  name: z.string(),
  logo_url: z.string().nullable(),
  brand_color: z.string().nullable(),
  is_cloud: z.boolean(),
  marketing_url: z.string().nullable(),
  hide_cloud_promo: z.boolean(),
  /**
   * Stable identifier for the org/tenant this swarm belongs to. Set by the
   * orchestrator on cloud deployments via `SWARM_ORG_ID`; null on self-host
   * unless the operator opts in. Threaded into telemetry events so multi-org
   * cloud installs can be sliced server-side.
   */
  org_id: z.string().nullable(),
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
  provider_id: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
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

// ─── Worker-reported credential rollup ───────────────────────────────────────

/**
 * Read all worker reports for a given harness provider and reduce them to a
 * single milestone-grade rollup. Reports are joined from `agents.cred_status`
 * (migration 055) — no provider-adapter code runs here.
 *
 * `verified` ⇐ at least one worker has `liveTest.ok === true` and the test
 *   is fresher than `getCredVerifyTtlMs()`.
 * `configured` ⇐ at least one worker has `ready: true` (presence check
 *   passed) but no fresh passing live test.
 * `unverified` ⇐ no worker reported, or all reporting workers have
 *   `ready: false`.
 */
type CredRollupState = "verified" | "configured" | "unverified";

interface CredRollup {
  state: CredRollupState;
  workers: number;
  reports: number;
  latestLiveTest: AgentCredStatus["liveTest"];
  latestMissing: string[];
  oldestReportAgeMs: number | null;
}

function getCredVerifyTtlMs(): number {
  const raw = process.env.SWARM_VERIFY_TTL_MS;
  if (!raw) return 3_600_000; // 1h default — matches pre-refactor behavior.
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 3_600_000;
  return parsed;
}

/**
 * Compatibility stub. The pre-refactor in-memory test-connection cache is
 * gone — credential state now lives on agent rows. Tests still call this
 * in `beforeEach` for backward compat; it's a no-op today.
 */
export function _resetTestConnectionCache(): void {
  // intentionally empty
}

function rollupCredStatusForProvider(provider: string): CredRollup {
  const agents = listAgentsWithCredStatusByProvider(provider);
  const reports = agents.map((a) => a.credStatus).filter((s): s is AgentCredStatus => s != null);

  if (reports.length === 0) {
    return {
      state: "unverified",
      workers: agents.length,
      reports: 0,
      latestLiveTest: null,
      latestMissing: [],
      oldestReportAgeMs: null,
    };
  }

  // Pick the most-recent passing live test, if any, then fall back to
  // most-recent live test of any kind.
  const ttl = getCredVerifyTtlMs();
  const now = Date.now();
  const passing = reports
    .filter((r) => r.liveTest?.ok === true && now - (r.liveTest?.testedAt ?? 0) < ttl)
    .sort((a, b) => (b.liveTest?.testedAt ?? 0) - (a.liveTest?.testedAt ?? 0));
  const anyLive = reports
    .filter((r) => r.liveTest != null)
    .sort((a, b) => (b.liveTest?.testedAt ?? 0) - (a.liveTest?.testedAt ?? 0));
  const latestLiveTest = passing[0]?.liveTest ?? anyLive[0]?.liveTest ?? null;

  const anyReady = reports.some((r) => r.ready);
  const state: CredRollupState =
    passing.length > 0 ? "verified" : anyReady ? "configured" : "unverified";

  // For UI hints, pick the most-recent missing[] from a not-ready report.
  const latestNotReady = reports
    .filter((r) => !r.ready)
    .sort((a, b) => b.reportedAt - a.reportedAt)[0];
  const latestMissing = latestNotReady?.missing ?? [];

  const oldestReportAgeMs =
    reports.length > 0 ? Math.max(...reports.map((r) => now - r.reportedAt)) : null;

  return {
    state,
    workers: agents.length,
    reports: reports.length,
    latestLiveTest,
    latestMissing,
    oldestReportAgeMs,
  };
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
    org_id: process.env.SWARM_ORG_ID?.trim() || null,
  };
}

// ─── Setup milestones ────────────────────────────────────────────────────────

/**
 * Compose a one-line, per-provider description for the milestone hint.
 * Examples:
 *   "1 worker · live test ok"
 *   "2 workers · presence ok, awaiting live test"
 *   "missing: OPENAI_API_KEY"
 */
function describeRoll(roll: CredRollup): string {
  if (roll.workers === 0) return "no workers";
  if (roll.reports === 0) {
    return `${roll.workers} ${roll.workers === 1 ? "worker" : "workers"}, none reported`;
  }
  const w = `${roll.workers} ${roll.workers === 1 ? "worker" : "workers"}`;
  if (roll.state === "verified") return `${w} · live test ok`;
  if (roll.state === "configured") return `${w} · presence ok, awaiting live test`;
  return roll.latestMissing.length > 0
    ? `missing: ${roll.latestMissing.join(", ")}`
    : "creds blocked";
}

/**
 * Fleet-aware harness milestone.
 *
 * Reads the agent fleet (distinct `harness_provider` values reported by
 * workers via migration 054/055), runs the cred-status rollup per provider,
 * and aggregates:
 *
 *   `verified`  — every provider in the fleet has a fresh passing live test.
 *   `configured` — every provider has at least `configured`, ≥1 not verified.
 *   `unverified` — any provider has `unverified` (no reports OR all-blocked).
 *
 * Crucially: the API never reads `process.env.HARNESS_PROVIDER` here.
 * `HARNESS_PROVIDER` is a worker-side env var; the API hosts a fleet that
 * may run several harnesses simultaneously. Empty fleet → `unverified` with
 * an onboarding hint.
 */
function harnessMilestone(): SetupMilestone {
  const fleet = getAgentHarnessProviders();

  if (fleet.length === 0) {
    return {
      id: "harness",
      label: "Harness configured",
      state: "unverified",
      hint: "No worker agents registered yet. Start a worker with HARNESS_PROVIDER set to one of: claude, codex, pi, devin, claude-managed, opencode.",
      action_url: "/agents",
    };
  }

  const perProvider = fleet
    .map(({ provider }) => {
      const parsed = ProviderNameSchema.safeParse(provider);
      if (!parsed.success) return null;
      return { provider: parsed.data, roll: rollupCredStatusForProvider(parsed.data) };
    })
    .filter(
      (x): x is { provider: z.infer<typeof ProviderNameSchema>; roll: CredRollup } => x !== null,
    );

  if (perProvider.length === 0) {
    return {
      id: "harness",
      label: "Harness configured",
      state: "unverified",
      hint: "Registered agents have unrecognised harness_provider values; check the agent rows.",
      action_url: "/agents",
    };
  }

  const states = perProvider.map((p) => p.roll.state);
  const aggregateState: SetupMilestoneState = states.every((s) => s === "verified")
    ? "verified"
    : states.every((s) => s !== "unverified")
      ? "configured"
      : "unverified";

  const hint = perProvider.map((p) => `${p.provider}: ${describeRoll(p.roll)}`).join(" · ");
  const singleProvider = perProvider.length === 1 ? perProvider[0]?.provider : undefined;

  return {
    id: "harness",
    label: "Harness configured",
    state: aggregateState,
    hint,
    action_url: aggregateState === "unverified" ? "/agents" : "/integrations",
    provider: singleProvider,
    providers: perProvider.map((p) => ({
      provider: p.provider,
      state: p.roll.state,
      workers: p.roll.workers,
    })),
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
 * Roll the setup state into a single tri-state health value used by the
 * header dot.
 *
 * Decision matrix:
 * - Harness `unverified` (no creds at all) → `broken` — the swarm cannot run a task.
 * - Workers `unverified` (no agents ever) → `broken` — same reason.
 * - Harness `configured` (creds present, never live-tested) → `degraded`.
 * - Any of {slack, github, linear, jira} `configured` (i.e. half-set-up) → `degraded`.
 * - Otherwise → `ok`.
 *
 * Notes:
 * - Worker `configured` (fleet exists but missed recent heartbeats) does NOT
 *   degrade the rollup. Heartbeat drift is a runtime concern surfaced on the
 *   /agents page and the dashboard canvas — not a setup health signal.
 * - Integrations in `unverified` are NOT degrading on their own — most
 *   deployments don't connect every integration. They only nudge the rollup if
 *   paired with another integration in `configured` (the brainstorm contract).
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
      ...getAgentFsStatusProvider(),
    },
    health: computeHealth(setup),
  };
}

function getAgentFsStatusProvider(): {
  provider_id: string;
  capabilities: Record<string, unknown>;
} {
  try {
    const provider = getFileStorageProvider();
    return {
      provider_id: provider.id,
      capabilities: provider.capabilities as Record<string, unknown>,
    };
  } catch {
    return {
      provider_id: "unavailable",
      capabilities: {},
    };
  }
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
    const roll = rollupCredStatusForProvider(provider);

    // No workers registered for this provider — the operator needs to start
    // a worker before any live test can run. Surface as a soft failure so
    // the UI can render the hint inline.
    if (roll.workers === 0) {
      json(res, {
        ok: false,
        error: `No workers registered with HARNESS_PROVIDER=${provider}. Start a worker — its boot loop will run a live test and report it here.`,
        latency_ms: 0,
      });
      return true;
    }

    if (!roll.latestLiveTest) {
      json(res, {
        ok: false,
        error:
          "Workers are registered but none have run a live test yet (still booting, or CRED_CHECK_DISABLE=1 was set).",
        latency_ms: 0,
      });
      return true;
    }

    json(res, {
      ok: roll.latestLiveTest.ok,
      ...(roll.latestLiveTest.error ? { error: roll.latestLiveTest.error } : {}),
      latency_ms: roll.latestLiveTest.latency_ms,
    });
    return true;
  }

  return false;
}
