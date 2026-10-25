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
  type AutomationSetupStates,
  automationIntegrationFixUrl,
  getAutomationSetupStates,
  listEnabledAutomationPreflightInputs,
  preflightAutomation,
} from "../be/automation-preflight";
import {
  getAgentHarnessProviders,
  getDbClient,
  getInstanceActivity,
  getLiveAgentCounts,
  getReadyAgentCounts,
  hasFirstCompletedTask,
  listAgentsWithCredStatusByProvider,
  NOT_EXTENSION_AGENT_SQL,
} from "../be/db";
import { getInstanceFeedbackSignals } from "../be/db/instance-signals";
import { getEmbeddingProvider } from "../be/memory";
import { runtimeSupervisorStatus } from "../be/runtime-pools/supervisor";
import { getCombServiceUserId } from "../comb/agent-fs";
import { getCombConfig } from "../comb/config";
import { getFileStorageProvider } from "../fs/registry";
import { getSlackConfiguration } from "../slack/config";
import { getSlackConnectionState } from "../slack/connection-state";
import { isTelemetryEnabled } from "../telemetry";
import { type AgentCredStatus, AutomationIntegrationIdSchema, ProviderNameSchema } from "../types";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const SetupMilestoneStateSchema = z.enum(["unverified", "configured", "verified"]);
export type SetupMilestoneState = z.infer<typeof SetupMilestoneStateSchema>;

export const SetupMilestoneIdSchema = z.enum([
  "harness",
  "embeddings",
  "slack",
  "github",
  "linear",
  "jira",
  "gsc",
  "agentmail",
  "agentfs",
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
  /**
   * Leads that can take work now (status `idle` or `busy`). Unlike
   * `leads_online`, this does not depend on a recent heartbeat: an idle lead
   * stops updating its activity time.
   */
  leads_ready: z.number().int().nonnegative(),
  recent_tasks_count: z.number().int().nonnegative(),
});
export type StatusActivity = z.infer<typeof StatusActivitySchema>;

export const StatusCombSchema = z.object({
  enabled: z.boolean(),
  api_url: z.string().nullable(),
  live_url: z.string(),
  org_id: z.string().nullable(),
  drive_id: z.string().nullable(),
  /** agent-fs user id of the swarm service account, which writes Comb's "sent" replies. */
  service_user_id: z.string().nullable(),
});

/**
 * Effective telemetry opt-out state (`ANONYMIZED_TELEMETRY`, on by default).
 * The dashboard reads it to stop its own browser-side notification events when
 * the operator opted out.
 */
export const StatusTelemetrySchema = z.object({
  enabled: z.boolean(),
});
export type StatusTelemetry = z.infer<typeof StatusTelemetrySchema>;

/**
 * Counts the dashboard's feedback pop-up decides on. `first_seen_at` is the
 * oldest agent registration: the install-age anchor when telemetry is off
 * and `telemetry_installed_at` does not exist.
 */
export const StatusInstanceSchema = z.object({
  first_seen_at: z.string().nullable(),
  tasks_completed: z.number().int().nonnegative(),
  tasks_failed: z.number().int().nonnegative(),
  workflow_runs_completed: z.number().int().nonnegative(),
});
export type StatusInstance = z.infer<typeof StatusInstanceSchema>;

export const StatusAgentFsSchema = z.object({
  configured: z.boolean(),
  base_url: z.string().nullable(),
  provider_id: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  /** Comb, the agent-fs review space in the dashboard. */
  comb: StatusCombSchema,
});
export type StatusAgentFs = z.infer<typeof StatusAgentFsSchema>;

export const AutomationStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["schedule", "workflow"]),
  state: z.enum(["running", "needs_setup"]),
  missing: z.object({
    params: z.array(z.string()),
    integrations: z.array(AutomationIntegrationIdSchema),
  }),
  fixes: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("param"), key: z.string(), url: z.string() }),
      z.object({
        type: z.literal("integration"),
        key: AutomationIntegrationIdSchema,
        url: z.string(),
      }),
    ]),
  ),
  fixUrl: z.string(),
});
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

/**
 * Phase 2: Aggregate health derived from setup milestones.
 *
 * - `broken`: harness or workers blocking (creds missing, no live workers ever).
 * - `degraded`: no lead can take work (none is `idle` or `busy`), OR at
 *   least one optional integration `unverified`/`configured` while another
 *   is configured, OR harness creds present but the latest live test failed
 *   or never ran (`configured`).
 * - `ok`: harness + workers `verified`, a lead can take work, and no
 *   integration left in `configured` state.
 */
export const StatusHealthSchema = z.enum(["ok", "degraded", "broken"]);
export type StatusHealth = z.infer<typeof StatusHealthSchema>;

export const StatusRuntimePoolsSchema = z.object({ enabled: z.boolean(), supervisor: z.string() });

export const StatusResponseSchema = z.object({
  runtime_pools: StatusRuntimePoolsSchema,
  identity: StatusIdentitySchema,
  setup: z.array(SetupMilestoneSchema),
  activity: StatusActivitySchema,
  agent_fs: StatusAgentFsSchema,
  automations: z.array(AutomationStatusSchema),
  /** Phase 2: rolled-up health for the always-on header badge. */
  health: StatusHealthSchema,
  /** Additive: absent on servers that predate it, so consumers treat missing as enabled. */
  telemetry: StatusTelemetrySchema.optional(),
  /** Additive: absent on servers that predate it. */
  instance: StatusInstanceSchema.optional(),
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
 * (migration 055) — no provider-adapter code runs here. Offline agents are
 * excluded: `workers` and `reports` count online agents only.
 *
 * `verified` ⇐ the provider's most recent live test passed, whatever its age.
 * `configured` ⇐ at least one worker has `ready: true` (presence check
 *   passed) but the latest live test failed or none ever ran.
 * `unverified` ⇐ no worker reported, or all reporting workers have
 *   `ready: false`.
 */
type CredRollupState = "verified" | "configured" | "unverified";

export interface CredRollup {
  state: CredRollupState;
  workers: number;
  verifiedWorkers: number;
  reports: number;
  latestLiveTest: AgentCredStatus["liveTest"];
  latestMissing: string[];
  oldestReportAgeMs: number | null;
}

/**
 * Compatibility stub. The pre-refactor in-memory test-connection cache is
 * gone — credential state now lives on agent rows. Tests still call this
 * in `beforeEach` for backward compat; it's a no-op today.
 */
export function _resetTestConnectionCache(): void {
  // intentionally empty
}

export async function rollupCredStatusForProvider(provider: string): Promise<CredRollup> {
  // An offline agent keeps its last cred_status after `/close`, so only online
  // agents decide the rollup; a stale failure must not override a live pass.
  const agents = (await listAgentsWithCredStatusByProvider(provider)).filter(
    (a) => a.status !== "offline",
  );
  const reports = agents.map((a) => a.credStatus).filter((s): s is AgentCredStatus => s != null);

  if (reports.length === 0) {
    return {
      state: "unverified",
      workers: agents.length,
      verifiedWorkers: 0,
      reports: 0,
      latestLiveTest: null,
      latestMissing: [],
      oldestReportAgeMs: null,
    };
  }

  // The provider's latest live test decides, whatever its age. Workers run the
  // test at boot and re-run it only when credentials change, so an old pass is
  // the normal state of a long-running worker, not a missing check.
  const now = Date.now();
  const passing = reports.filter((r) => r.liveTest?.ok === true);
  const anyLive = reports
    .filter((r) => r.liveTest != null)
    .sort((a, b) => (b.liveTest?.testedAt ?? 0) - (a.liveTest?.testedAt ?? 0));
  const latestLiveTest = anyLive[0]?.liveTest ?? null;

  const anyReady = reports.some((r) => r.ready);
  const state: CredRollupState =
    latestLiveTest?.ok === true ? "verified" : anyReady ? "configured" : "unverified";

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
    // Every agent on the harness counts (leads too), same as `workers` and `state`.
    verifiedWorkers: passing.length,
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
 * One short phrase for a provider that needs attention, e.g. "live test
 * failed" or "missing: OPENAI_API_KEY". A verified provider gets none.
 */
function describeRoll(roll: CredRollup): string | null {
  if (roll.state === "verified") return null;
  if (roll.workers === 0) return "no workers";
  if (roll.reports === 0) return "no credential report";
  if (roll.state === "configured") {
    return roll.latestLiveTest?.ok === false ? "live test failed" : "not live-tested";
  }
  return roll.latestMissing.length > 0
    ? `missing: ${roll.latestMissing.join(", ")}`
    : "credentials blocked";
}

/**
 * Fleet-aware harness milestone.
 *
 * Reads the agent fleet (distinct `harness_provider` values reported by
 * workers via migration 054/055), runs the cred-status rollup per provider,
 * and aggregates:
 *
 *   `verified`  — every provider's latest live test passed.
 *   `configured` — every provider has at least `configured`, ≥1 not verified.
 *   `unverified` — any provider has `unverified` (no reports OR all-blocked).
 *
 * Crucially: the API never reads `process.env.HARNESS_PROVIDER` here.
 * `HARNESS_PROVIDER` is a worker-side env var; the API hosts a fleet that
 * may run several harnesses simultaneously. Empty fleet → `unverified` with
 * an onboarding hint.
 */
async function harnessMilestone(): Promise<SetupMilestone> {
  const fleet = await getAgentHarnessProviders();

  if (fleet.length === 0) {
    return {
      id: "harness",
      label: "Harness configured",
      state: "unverified",
      hint: "No worker agents registered yet. Start a worker with HARNESS_PROVIDER set to one of: claude, codex, pi, devin, claude-managed, opencode.",
      action_url: "/agents",
    };
  }

  const perProvider: { provider: z.infer<typeof ProviderNameSchema>; roll: CredRollup }[] = [];
  let recognised = 0;
  for (const { provider } of fleet) {
    const parsed = ProviderNameSchema.safeParse(provider);
    if (!parsed.success) continue;
    recognised++;
    const roll = await rollupCredStatusForProvider(parsed.data);
    // A provider whose agents are all offline has nothing live to judge.
    if (roll.workers === 0) continue;
    perProvider.push({ provider: parsed.data, roll });
  }

  if (recognised > 0 && perProvider.length === 0) {
    return {
      id: "harness",
      label: "Harness configured",
      state: "unverified",
      hint: "No agents online. Start a worker to run a live credential test.",
      action_url: "/agents",
    };
  }

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

  const hint =
    perProvider
      .flatMap((p) => {
        const phrase = describeRoll(p.roll);
        return phrase ? [`${p.provider}: ${phrase}`] : [];
      })
      .join(" · ") || undefined;
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

function embeddingsMilestone(): SetupMilestone {
  // Ask the live provider rather than re-deriving key precedence here — it
  // reflects whatever the last config reload (or boot) resolved, including
  // an explicitly empty EMBEDDING_API_KEY disabling the OPENAI_API_KEY
  // fallback. See OpenAIEmbeddingProvider.isConfigured().
  if (getEmbeddingProvider().isConfigured()) {
    return {
      id: "embeddings",
      label: "Memory search",
      state: "configured",
    };
  }

  return {
    id: "embeddings",
    label: "Memory search",
    state: "unverified",
    hint: "Memory search is off. Set OPENAI_API_KEY (or EMBEDDING_API_KEY) on the API server to enable it; it is cheap.",
  };
}

function slackMilestone(state: AutomationSetupStates["slack"]): SetupMilestone {
  const config = getSlackConfiguration();

  if (state === "unverified") {
    let hint: string;
    if (config.disabled) {
      hint = "Slack is explicitly disabled (SLACK_DISABLE=true).";
    } else if (!config.mode) {
      hint = "Invalid SLACK_MODE. Use socket or http.";
    } else if (config.mode === "http" && config.missingCredentials.length === 0) {
      hint =
        "HTTP credentials are configured, but HTTP ingress is unavailable until the receiver is installed.";
    } else {
      hint = `Set ${config.missingCredentials.join(" + ")} for Slack ${config.mode} mode.`;
    }
    return {
      id: "slack",
      label: "Slack configured",
      state: "unverified",
      hint,
      action_url: automationIntegrationFixUrl("slack"),
    };
  }

  if (config.mode === "socket" && getSlackConnectionState() === "connected") {
    return {
      id: "slack",
      label: "Slack configured",
      state: "verified",
      action_url: automationIntegrationFixUrl("slack"),
    };
  }

  return {
    id: "slack",
    label: "Slack configured",
    state: "configured",
    hint:
      config.mode === "http"
        ? "HTTP credentials are configured, but HTTP ingress is unavailable until the receiver is installed."
        : "Socket Mode credentials are configured, but the bot is not connected to Slack.",
    action_url: automationIntegrationFixUrl("slack"),
  };
}

function githubMilestone(state: AutomationSetupStates["github"]): SetupMilestone {
  if (state === "unverified") {
    return {
      id: "github",
      label: "GitHub App connected",
      state: "unverified",
      hint: "Set GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY.",
      action_url: automationIntegrationFixUrl("github"),
    };
  }
  return {
    id: "github",
    label: "GitHub App connected",
    state: "verified",
    action_url: automationIntegrationFixUrl("github"),
  };
}

function linearMilestone(state: AutomationSetupStates["linear"]): SetupMilestone {
  if (state === "unverified") {
    return {
      id: "linear",
      label: "Linear connected",
      state: "unverified",
      hint: "Connect Linear via the integrations page.",
      action_url: automationIntegrationFixUrl("linear"),
    };
  }
  return {
    id: "linear",
    label: "Linear connected",
    state: "verified",
    hint: "Token row present; refresh-failure tracking will land in a future migration — check #swarm-alerts for keepalive errors.",
    action_url: automationIntegrationFixUrl("linear"),
  };
}

function jiraMilestone(state: AutomationSetupStates["jira"]): SetupMilestone {
  if (state === "unverified") {
    return {
      id: "jira",
      label: "Jira connected",
      state: "unverified",
      hint: "Connect Jira and finish the OAuth callback via the integrations page.",
      action_url: automationIntegrationFixUrl("jira"),
    };
  }
  return {
    id: "jira",
    label: "Jira connected",
    state: "verified",
    hint: "Token row present; refresh-failure tracking will land in a future migration — check #swarm-alerts for keepalive errors.",
    action_url: automationIntegrationFixUrl("jira"),
  };
}

function gscMilestone(state: AutomationSetupStates["gsc"]): SetupMilestone {
  return {
    id: "gsc",
    label: "Google Search Console connected",
    state,
    ...(state === "unverified"
      ? { hint: "Set GSC_SERVICE_ACCOUNT_BASE64 to connect Google Search Console." }
      : {}),
    action_url: automationIntegrationFixUrl("gsc"),
  };
}

function agentmailMilestone(state: AutomationSetupStates["agentmail"]): SetupMilestone {
  return {
    id: "agentmail",
    label: "AgentMail connected",
    state,
    ...(state === "unverified"
      ? { hint: "Set AGENTMAIL_API_KEY to let automations send email." }
      : {}),
    action_url: automationIntegrationFixUrl("agentmail"),
  };
}

function agentfsMilestone(state: AutomationSetupStates["agentfs"]): SetupMilestone {
  return {
    id: "agentfs",
    label: "Agent File System connected",
    state,
    ...(state === "unverified"
      ? { hint: "Configure the agent-fs URL, API key, default org, and default drive." }
      : {}),
    action_url: automationIntegrationFixUrl("agentfs"),
  };
}

async function workersMilestone(): Promise<SetupMilestone> {
  // `configured` if ≥1 row in agents; `verified` if both lead+worker alive
  // within the last 5 minutes.
  const totalRow = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM agents WHERE ${NOT_EXTENSION_AGENT_SQL}`,
  );
  const totalAgents = totalRow?.count ?? 0;

  const { leads_alive, workers_alive } = await getLiveAgentCounts(5);
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

async function firstTaskMilestone(): Promise<SetupMilestone> {
  if (await hasFirstCompletedTask()) {
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

export async function buildSetup(
  automationSetup?: AutomationSetupStates,
): Promise<SetupMilestone[]> {
  automationSetup ??= await getAutomationSetupStates();
  return [
    await harnessMilestone(),
    embeddingsMilestone(),
    slackMilestone(automationSetup.slack),
    githubMilestone(automationSetup.github),
    linearMilestone(automationSetup.linear),
    jiraMilestone(automationSetup.jira),
    gscMilestone(automationSetup.gsc),
    agentmailMilestone(automationSetup.agentmail),
    agentfsMilestone(automationSetup.agentfs),
    await workersMilestone(),
    await firstTaskMilestone(),
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
 * - No lead can take work (`readyLeads` is 0) → `degraded`. Tasks wait until a lead is online.
 * - Harness `configured` (creds present, never live-tested) → `degraded`.
 * - Any of {slack, github, linear, jira} `configured` (i.e. half-set-up) → `degraded`.
 * - Otherwise → `ok`.
 *
 * Notes:
 * - `readyLeads` counts leads with status `idle` or `busy`
 *   (`getReadyAgentCounts`). It does not use the heartbeat time: an agent
 *   updates `lastActivityAt` only while a session runs, so an idle, healthy
 *   lead looks stale.
 * - Worker `configured` (fleet exists but missed recent heartbeats) does NOT
 *   degrade the rollup on its own, for the same reason.
 * - Integrations in `unverified` are NOT degrading on their own — most
 *   deployments don't connect every integration. They only nudge the rollup if
 *   paired with another integration in `configured` (the brainstorm contract).
 */
export function computeHealth(setup: SetupMilestone[], readyLeads: number): StatusHealth {
  const byId = new Map(setup.map((m) => [m.id, m] as const));
  const harness = byId.get("harness");
  const workers = byId.get("workers");

  // `broken` rules — critical blockers.
  if (!harness || harness.state === "unverified") return "broken";
  if (!workers || workers.state === "unverified") return "broken";

  // `degraded` rules.
  if (readyLeads === 0) return "degraded";
  if (harness.state === "configured") return "degraded";

  for (const id of ["slack", "github", "linear", "jira"] as const) {
    const m = byId.get(id);
    if (m?.state === "configured") return "degraded";
  }

  return "ok";
}

// ─── Public payload builder (also exported for tests) ────────────────────────

export async function buildStatusPayload(): Promise<StatusResponse> {
  // step-9: the agent-fs identity lookup (at most 2 s) runs while the DB work below does.
  const combServiceUserId = getCombConfig().enabled
    ? getCombServiceUserId()
    : Promise.resolve(null);
  const automationSetup = await getAutomationSetupStates();
  const setup = await buildSetup(automationSetup);
  const automationInputs = await listEnabledAutomationPreflightInputs();
  const toStatus = ({ failureReason: _, ...status }: ReturnType<typeof preflightAutomation>) =>
    status;
  const automations: AutomationStatus[] = automationInputs
    .map((automation) => toStatus(preflightAutomation(automation, automationSetup)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  const activity = await getInstanceActivity();
  const readyLeads = (await getReadyAgentCounts()).leads;
  const instance = await getInstanceFeedbackSignals();
  return {
    runtime_pools: { enabled: isRuntimePoolsEnabled(), supervisor: runtimeSupervisorStatus() },
    identity: buildIdentity(),
    setup,
    activity: { ...activity, leads_ready: readyLeads },
    agent_fs: {
      configured: !!process.env.AGENT_FS_API_URL,
      base_url: process.env.AGENT_FS_API_URL ?? null,
      ...getAgentFsStatusProvider(),
      comb: getCombStatus(await combServiceUserId),
    },
    automations,
    health: computeHealth(setup, readyLeads),
    telemetry: { enabled: isTelemetryEnabled() },
    instance,
  };
}

function getCombStatus(serviceUserId: string | null): StatusAgentFs["comb"] {
  const comb = getCombConfig();
  return {
    enabled: comb.enabled,
    api_url: comb.apiUrl,
    live_url: comb.liveUrl,
    org_id: comb.orgId,
    drive_id: comb.driveId,
    service_user_id: comb.enabled ? serviceUserId : null,
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
    "Single source of truth consumed by the UI home page. Identity comes from SWARM_* envs; setup milestones each emit `unverified | configured | verified`; automations report `running | needs_setup` from the same runtime preflight used at dispatch; activity counts agents alive in the last 5 min, leads that can take work (status idle or busy), and tasks created in the last 24h; agent_fs reports whether AGENT_FS_API_URL is set, plus the Comb settings (COMB_ENABLED, the browser-facing agent-fs URL, the shared org and drive ids, and the agent-fs user id of the swarm service account); telemetry reports the effective ANONYMIZED_TELEMETRY opt-out state.",
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
  summary: "Read worker-reported harness credential status",
  description:
    "Reads worker-reported credential checks from agent rows. This route makes no upstream request and returns a reported live-test result when one exists.",
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
      const payload = await buildStatusPayload();
      getStatus.respond(res, 200, payload);
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : "Failed to build status", 500);
    }
    return true;
  }

  if (postTestConnection.match(req.method, pathSegments)) {
    const parsed = await postTestConnection.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { provider } = parsed.body;
    const roll = await rollupCredStatusForProvider(provider);

    // No workers registered for this provider — the operator needs to start
    // a worker before any live test can run. Surface as a soft failure so
    // the UI can render the hint inline.
    if (roll.workers === 0) {
      json(res, {
        ok: false,
        error: `No online workers with HARNESS_PROVIDER=${provider}. Start a worker — its boot loop will run a live test and report it here.`,
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
