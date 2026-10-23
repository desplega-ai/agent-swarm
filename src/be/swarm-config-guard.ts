import { validateChatSdkAdaptersValue } from "../integrations/chat-sdk/schema";
import { parseTelemetryRanking, TELEMETRY_RANKING_KEY } from "../ranking/telemetry-ranking";
import { validateQuickJSPoolSize } from "../scripts-runtime/executors/quickjs-pool-config";
import { normalizeSlackReactionShortcode } from "../slack/reaction-shortcode";
import { ProviderNameSchema } from "../types";
import { API_DRAIN_MAX_MS_LIMIT } from "../utils/api-drain";
import {
  COMPANY_ACQUISITION_SOURCES,
  COMPANY_TEAM_SIZES,
  COMPANY_USE_CASES,
} from "../utils/company-profile";
import { envExportRestrictedError, isEnvExportRestrictedKey } from "../utils/config-env-export";
import { validateEgressAllowlist } from "../utils/egress-guard";
import { parseEnabledTools } from "../utils/enabled-tools";
import { normalizeOrgWebsite } from "../utils/org-website";
import { parseTaskToolManifest } from "../utils/task-tool-manifest";
import { isTierConfigKey, validateTierConfigValue } from "./model-tier-keys";

/**
 * Guards against storing reserved keys in the swarm_config table.
 *
 * `API_KEY` and `SECRETS_ENCRYPTION_KEY` must live only in the process
 * environment (or a .env file) — persisting them in swarm_config would
 * create a chicken-and-egg problem:
 *   - `API_KEY` controls access to the HTTP API that reads swarm_config.
 *   - `SECRETS_ENCRYPTION_KEY` is required to decrypt secrets stored in
 *     swarm_config, so it cannot itself be stored encrypted there.
 *
 * `CORS_ALLOW_ANY_ORIGIN` is deployment-only: runtime config must not
 * re-enable unrestricted credentialed CORS.
 *
 * Matching is case-insensitive so `api_key`, `Api_Key`, etc. are all
 * rejected at every write path (DB helpers, HTTP routes, MCP tools).
 */
// Lead activation is also deployment-only: leads can write ordinary global config.
// CHAT_SDK_API_URL_OVERRIDES points Chat SDK adapters (and the secrets they carry)
// at another host, so it must never come from a config row.
/**
 * Teams SDK env fallbacks; a config row must not redirect the bot token.
 * `@microsoft/teams.apps` reads these from `process.env`. Operators may still
 * store them (they are not reserved), they just never reach env through
 * `getInjectableGlobalConfigs`.
 */
export const TEAMS_SDK_ENV_KEYS = [
  "SERVICE_URL",
  "TENANT_ID",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "MANAGED_IDENTITY_CLIENT_ID",
  "CLOUD",
] as const;

/** SQL literal list for the `NOT IN (...)` injection denylist in db.ts. */
export function teamsSdkEnvKeysSql(): string {
  return TEAMS_SDK_ENV_KEYS.map((key) => `'${key}'`).join(", ");
}

const RESERVED_KEYS = new Set([
  "API_KEY",
  "SECRETS_ENCRYPTION_KEY",
  "CORS_ALLOW_ANY_ORIGIN",
  "EXTENSION_ALLOW_LEAD_ACTIVATION",
  "CHAT_SDK_API_URL_OVERRIDES",
]);

// Config keys the API server owns for its own use and must NEVER hand out over
// HTTP or to a script — workers/entrypoints read config to build their env, and
// the agent-fs bootstrap admin key would let a compromised worker administer the
// shared org. The API materializes these into its own process.env at boot via
// getInjectableGlobalConfigs, so no HTTP consumer legitimately needs them.
const API_ONLY_CONFIG_KEYS = new Set([
  "API_AGENT_FS_API_KEY",
  "SLACK_SIGNING_SECRET",
  "TRANSCRIPTION_API_KEY",
]);

export function isApiOnlyConfigKey(key: string): boolean {
  return API_ONLY_CONFIG_KEYS.has(key);
}

/** Config rows owned by dedicated API surfaces, not the generic config API. */
export const INTERNAL_CONFIG_KEYS = new Set([
  "onboarding_state",
  "runtime_owner_id",
  TELEMETRY_RANKING_KEY,
]);

export function isInternalConfigKey(key: string): boolean {
  return INTERNAL_CONFIG_KEYS.has(key.toLowerCase());
}

export function internalConfigKeyError(key: string): Error {
  const lower = key.toLowerCase();
  const owner =
    lower === "runtime_owner_id"
      ? "the runtime supervisor"
      : lower === TELEMETRY_RANKING_KEY
        ? "/api/ranking"
        : "/api/onboarding";
  return new Error(`Key '${key}' is managed by ${owner}`);
}

export function isReservedConfigKey(key: string): boolean {
  return RESERVED_KEYS.has(key.toUpperCase());
}

export function reservedKeyError(key: string): Error {
  return new Error(
    `Key '${key}' is reserved and cannot be stored in swarm_config. ` +
      `Set it as an environment variable instead.`,
  );
}

/**
 * Per-key value validators run on `upsertSwarmConfig` writes via the HTTP
 * config API. Use this when an invalid value would silently break workers
 * (e.g. typo'd HARNESS_PROVIDER would fall back to "claude" with only a
 * console.warn — the operator wouldn't see why their config was ignored).
 *
 * Returns a human-readable error string when the value is invalid, or
 * `null` when the key has no validator or the value passes.
 */
type ConfigValidator = (value: unknown) => string | null;

const BOOLEAN_LITERALS = ["true", "false", "1", "0"];

/** A conservative window that remains representable by JavaScript Date arithmetic. */
export const MAX_DB_RETENTION_DAYS = 1_000_000;

/**
 * The one source of truth for the retention tick's tuning ranges.
 *
 * db-retention.ts clamps each knob to exactly these bounds and falls back to
 * its default outside them, and VALIDATED_KEYS below rejects out-of-range
 * writes with the same numbers. Both sides read this constant, so the config
 * API cannot accept a value the sweep will silently ignore. It lives here
 * because db-retention.ts already imports from this module; the reverse
 * direction would be a cycle.
 */
export const DB_RETENTION_TUNING_BOUNDS = {
  DB_RETENTION_TICK_BUDGET_MS: { min: 1_000, max: 300_000 },
  DB_RETENTION_CATCHUP_INTERVAL_MS: { min: 5_000, max: 3_600_000 },
  DB_RETENTION_MAX_STATEMENT_MS: { min: 25, max: 5_000 },
} as const;

/**
 * Bounds for the Swarm Apps json column size cap (`APPS_JSON_COLUMN_MAX_BYTES`).
 *
 * `src/apps/definition.ts` reads the knob against exactly these at call time
 * and falls back to its 256 KB default outside them; VALIDATED_KEYS below
 * rejects out-of-range writes with the same numbers, so the config API cannot
 * accept a cap the row store would silently ignore.
 */
export const APPS_JSON_COLUMN_MAX_BYTES_BOUNDS = { min: 1_024, max: 16_777_216 } as const;

/**
 * Bounds for the Codex OAuth keep-warm age threshold
 * (`CODEX_OAUTH_KEEP_WARM_MAX_AGE_HOURS`).
 *
 * `src/http/codex-oauth-keep-warm.ts` reads the knob against exactly these at
 * call time and falls back to its default outside them. The 216 h (9 day)
 * ceiling stays under the 9.5 day point where task-time near-expiry refresh
 * takes over, so every accepted value still changes when a slot refreshes.
 */
export const CODEX_OAUTH_KEEP_WARM_MAX_AGE_HOURS_BOUNDS = { min: 1, max: 216 } as const;

/**
 * Decision hosts `SYSTEM_ONE_DEFAULT_PROVIDER` may name: `SYSTEM_ONE_PROVIDER_IDS`
 * in `src/workflows/executors/system-one-providers.ts`, listed here because that
 * module's credential readers would pull the LLM stack into every `db.ts` import.
 * A test keeps the two lists equal.
 */
export const SYSTEM_ONE_DEFAULT_PROVIDER_OPTIONS = [
  "typesafe",
  "openrouter",
  "laya",
  "openai",
  "cloudflare",
] as const;

/** Build `{ KEY: validator }` entries accepting only boolean literals. */
function booleanValidators(keys: string[]): Record<string, ConfigValidator> {
  const message = (key: string) =>
    `Invalid ${key} value (must be one of: ${BOOLEAN_LITERALS.join(", ")})`;
  return Object.fromEntries(
    keys.map((key) => [
      key,
      (value: unknown) => {
        if (typeof value !== "string") return message(key);
        return BOOLEAN_LITERALS.includes(value.trim().toLowerCase()) ? null : message(key);
      },
    ]),
  );
}

/** Build a single `{ KEY: validator }` entry restricted to `options`. */
function enumValidator(key: string, options: string[]): Record<string, ConfigValidator> {
  const listed = options.filter(Boolean).join(", ");
  const message = `Invalid ${key} value (must be one of: ${listed}${options.includes("") ? ", or empty" : ""})`;
  return {
    [key]: (value: unknown) => {
      if (typeof value !== "string") return message;
      return options.includes(value.trim()) ? null : message;
    },
  };
}

/** Build `{ KEY: validator }` entries accepting a Slack emoji shortcode. */
function shortcodeValidators(keys: string[]): Record<string, ConfigValidator> {
  const message = (key: string) =>
    `Invalid ${key} (must be a Slack emoji shortcode: lowercase letters, digits, _ + ' -, with optional surrounding colons)`;
  return Object.fromEntries(
    keys.map((key) => [
      key,
      (value: unknown) => (normalizeSlackReactionShortcode(value) !== null ? null : message(key)),
    ]),
  );
}

/** Build `{ KEY: validator }` entries accepting integers >= `min`. */
function integerValidators(keys: string[], min: number): Record<string, ConfigValidator> {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      (value: unknown) => {
        const str = String(value).trim();
        if (!/^\d+$/.test(str) || Number(str) < min) {
          return `Invalid ${key} (must be an integer >= ${min})`;
        }
        return null;
      },
    ]),
  );
}

/** Build `{ KEY: validator }` entries from a per-key closed range. */
function boundedIntegerValidatorsFor(
  bounds: Record<string, { min: number; max: number }>,
): Record<string, ConfigValidator> {
  const validators: Record<string, ConfigValidator> = {};
  for (const [key, { min, max }] of Object.entries(bounds)) {
    Object.assign(validators, boundedIntegerValidators([key], min, max));
  }
  return validators;
}

/** Build `{ KEY: validator }` entries accepting integers inside a closed range. */
function boundedIntegerValidators(
  keys: string[],
  min: number,
  max: number,
): Record<string, ConfigValidator> {
  return Object.fromEntries(
    keys.map((key) => [
      key,
      (value: unknown) => {
        const str = String(value).trim();
        const parsed = Number(str);
        if (!/^\d+$/.test(str) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
          return `Invalid ${key} (must be an integer between ${min} and ${max})`;
        }
        return null;
      },
    ]),
  );
}

/**
 * Blank or an http(s) URL with no query string or fragment. Returns `invalid`
 * for anything else. Blank is allowed: it is how an operator reverts to the
 * key's fallback without deleting the row.
 */
function validateHttpBaseUrl(value: unknown, invalid: string): string | null {
  if (typeof value !== "string") return invalid;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return invalid;
    if (url.search || url.hash) return invalid;
  } catch {
    return invalid;
  }
  return null;
}

function validateFloatRange(
  key: string,
  value: unknown,
  min: number,
  max: number,
  expectation: string,
): string | null {
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return `Invalid ${key} (must be ${expectation})`;
  }
  return null;
}

export function validateRuntimeTokenTtlHours(value: unknown): string | null {
  const hours = Number(value);
  return typeof value === "string" && Number.isFinite(hours) && hours > 0 && hours <= 168
    ? null
    : "Invalid RUNTIME_TOKEN_TTL_HOURS (must be greater than zero and at most 168)";
}

export const validateControllerTokenTtlDays = boundedIntegerValidators(
  ["RUNTIME_CONTROLLER_TOKEN_TTL_DAYS"],
  1,
  3650,
).RUNTIME_CONTROLLER_TOKEN_TTL_DAYS!;

export const validateControllerGraceSec = boundedIntegerValidators(
  ["RUNTIME_CONTROLLER_GRACE_SEC"],
  0,
  86_400,
).RUNTIME_CONTROLLER_GRACE_SEC!;

const VALIDATED_KEYS: Record<string, ConfigValidator> = {
  ...booleanValidators(["RUNTIME_POOLS_ENABLED"]),
  ...enumValidator("RUNTIME_DEFAULT_DELIVERY", ["poll", "push"]),
  RUNTIME_TOKEN_TTL_HOURS: validateRuntimeTokenTtlHours,
  RUNTIME_CONTROLLER_TOKEN_TTL_DAYS: validateControllerTokenTtlDays,
  RUNTIME_CONTROLLER_GRACE_SEC: validateControllerGraceSec,
  ...integerValidators(
    [
      "RUNTIME_SUPERVISOR_INTERVAL_MS",
      "RUNTIME_PROVISION_TIMEOUT_SEC",
      "RUNTIME_PROVISION_CONCURRENCY",
      "RUNTIME_PER_TASK_EXIT_GRACE_SEC",
      "RUNTIME_PROVISION_MAX_ATTEMPTS",
      "RUNTIME_CIRCUIT_THRESHOLD",
      "RUNTIME_CIRCUIT_OPEN_MIN",
      "RUNTIME_TOKEN_ROTATE_BEFORE_MIN",
      "RUNTIME_LEASE_RENEW_BEFORE_SEC",
      "RUNTIME_E2B_BUILD_TIMEOUT_SEC",
      "RUNTIME_ROTATE_BEFORE_SEC",
      "E2B_MAX_CONTINUOUS_SEC",
    ],
    1,
  ),
  ...integerValidators(["RUNTIME_SOCKET_GRACE_SEC"], 0),
  ...integerValidators(
    ["RUNTIME_WAKE_GRACE_SEC", "RUNTIME_WAKE_REROUTE_SEC", "RUNTIME_ROUTING_INTERVAL_MS"],
    0,
  ),
  CHAT_SDK_ADAPTERS: validateChatSdkAdaptersValue,
  TASK_TOOL_MANIFESTS: (value) => {
    try {
      if (typeof value !== "string") throw new Error("Expected JSON string");
      parseTaskToolManifest(value);
      return null;
    } catch {
      return "Invalid TASK_TOOL_MANIFESTS (expected JSON with taskTypes and/or schedules maps, each selecting at most 16 known swarm tools)";
    }
  },
  // Owned by /api/ranking (an internal key); parsed here as defense in depth.
  [TELEMETRY_RANKING_KEY.toUpperCase()]: (value) => {
    try {
      if (typeof value !== "string") throw new Error("Expected JSON string");
      parseTelemetryRanking(value);
      return null;
    } catch {
      return "Invalid telemetry_ranking (expected the v1 ranking listing JSON)";
    }
  },
  // MCP tool allowlist: comma-separated names or a JSON array of strings.
  // Unknown names are accepted here and warned about at session init.
  SWARM_ENABLED_TOOLS: (value) => {
    try {
      if (typeof value !== "string") throw new Error("Expected string");
      parseEnabledTools(value);
      return null;
    } catch {
      return "Invalid SWARM_ENABLED_TOOLS (expected comma-separated tool names or a JSON array of strings)";
    }
  },
  FEEDBACK_ENDPOINT: (value) => {
    if (typeof value !== "string") {
      return "Invalid FEEDBACK_ENDPOINT (must use HTTPS, or HTTP on a loopback host)";
    }

    try {
      const endpoint = new URL(value.trim());
      const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
      if (endpoint.protocol === "https:") return null;
      if (endpoint.protocol === "http:" && loopbackHosts.has(endpoint.hostname)) return null;
    } catch {
      // Fall through to the shared validation error.
    }

    return "Invalid FEEDBACK_ENDPOINT (must use HTTPS, or HTTP on a loopback host)";
  },
  // OpenAI-compatible model gateway for every OpenRouter consumer (OpenCode and
  // pi-mono sessions, model refreshes, internal summarizers). Call sites append
  // `/models` and `/chat/completions` to it, so a value carrying a query string
  // or a fragment would build a nonsense URL — reject those here rather than
  // letting workers fail one request at a time. Blank is meaningful and allowed:
  // it is how an operator reverts to openrouter.ai without deleting the row.
  OPENROUTER_BASE_URL: (value) =>
    validateHttpBaseUrl(
      value,
      "Invalid OPENROUTER_BASE_URL (must be an http(s) URL with no query string or fragment, e.g. https://api.example.com/v1. Leave blank for openrouter.ai)",
    ),
  // Browser-facing agent-fs URL for Comb. Blank falls back to AGENT_FS_API_URL.
  AGENT_FS_PUBLIC_URL: (value) =>
    validateHttpBaseUrl(
      value,
      "Invalid AGENT_FS_PUBLIC_URL (must be an http(s) URL with no query string or fragment, e.g. https://agent-fs.example.com. Leave blank to use AGENT_FS_API_URL)",
    ),
  HARNESS_PROVIDER: (value) => {
    const parsed = ProviderNameSchema.safeParse(value);
    if (parsed.success) return null;
    return `Invalid HARNESS_PROVIDER value (must be one of: ${ProviderNameSchema.options.join(", ")})`;
  },
  ...enumValidator("CLAUDE_TRANSPORT", ["cli", "sdk"]),
  ...enumValidator("SCRIPT_EXECUTOR", ["native", "quickjs"]),
  ...enumValidator("TRANSCRIPTION_PROVIDER", ["openai", "elevenlabs", "groq"]),
  SCRIPT_QUICKJS_POOL_SIZE: validateQuickJSPoolSize,
  ...booleanValidators(["SCRIPT_EGRESS_ALLOW_PRIVATE"]),
  SCRIPT_EGRESS_ALLOWLIST: (value) =>
    typeof value === "string" ? validateEgressAllowlist(value) : "Invalid SCRIPT_EGRESS_ALLOWLIST",
  // fail: worker fails a task fast when every key has exhausted the task
  // model's weekly window (Fable/Opus/Sonnet). fallback: legacy random pick.
  ...enumValidator("MODEL_WINDOW_EXHAUSTED_POLICY", ["fail", "fallback"]),
  ...enumValidator("HEARTBEAT_CHECKLIST_GATE_MODE", ["shadow", "enforce"]),
  ...enumValidator("SYSTEM_ONE_DEFAULT_PROVIDER", [...SYSTEM_ONE_DEFAULT_PROVIDER_OPTIONS]),
  // Codex credits-exhausted cooldown (ms). Permissive on range here (positive
  // integer) — the worker clamps to [5m, 7d] via resolveCodexCreditsExhaustedCooldownMs.
  CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS: (value) => {
    const str = String(value).trim();
    if (!/^\d+$/.test(str) || Number(str) <= 0) {
      return "Invalid CODEX_CREDITS_EXHAUSTED_COOLDOWN_MS (must be a positive integer of milliseconds)";
    }
    return null;
  },
  SWARM_USE_CLAUDE_BRIDGE: (value) => {
    if (typeof value !== "string") {
      return "Invalid SWARM_USE_CLAUDE_BRIDGE value (must be one of: true, false, 1, 0)";
    }
    const normalized = value.trim().toLowerCase();
    if (["true", "false", "1", "0"].includes(normalized)) return null;
    return "Invalid SWARM_USE_CLAUDE_BRIDGE value (must be one of: true, false, 1, 0)";
  },
  // AWS credential mode for the Bedrock path on the pi harness.
  //   sdk    — AWS SDK default credential chain (env, ~/.aws/*, SSO, IMDS, …)
  //   bearer — explicit Bedrock API key via AWS_BEARER_TOKEN_BEDROCK (required in this mode)
  // When absent the worker infers the mode from MODEL_OVERRIDE (sdk semantics).
  BEDROCK_AUTH_MODE: (value) => {
    if (value === "sdk" || value === "bearer") return null;
    return "Invalid BEDROCK_AUTH_MODE value (must be one of: sdk, bearer)";
  },
  // Logical agent concurrency policy (agent scope) — the authoritative source
  // that upsertSwarmConfigWithPolicyMirror mirrors into agents.maxTasks.
  // Bounded to AgentSchema's maxTasks range [1, 100] so the mirrored column
  // stays schema-valid.
  AGENT_MAX_TASKS: (value) => {
    const str = String(value).trim();
    if (!/^\d+$/.test(str) || Number(str) < 1 || Number(str) > 100) {
      return "Invalid AGENT_MAX_TASKS (must be an integer between 1 and 100)";
    }
    return null;
  },
  // A bare public hostname, as `normalizeOrgWebsite` stores it, or empty to clear it.
  SWARM_ORG_WEBSITE: (value) => {
    const str = String(value).trim();
    return str === "" || normalizeOrgWebsite(str) === str
      ? null
      : "Invalid SWARM_ORG_WEBSITE (must be a public hostname such as example.com, without scheme, www, path or port)";
  },
  ...enumValidator("SWARM_ORG_TEAM_SIZE", ["", ...COMPANY_TEAM_SIZES]),
  ...enumValidator("SWARM_ORG_USE_CASE", ["", ...COMPANY_USE_CASES]),
  ...enumValidator("SWARM_ORG_ACQUISITION_SOURCE", ["", ...COMPANY_ACQUISITION_SOURCES]),
  ...booleanValidators([
    "SWARM_USED_BY_CONSENT",
    "PUBLIC_RANKING_ENABLED",
    "SWARM_DEV_MODE",
    "MULTI_RUNTIME_ENABLED",
    "STEERING_ENABLED",
    "MEMORY_HYBRID_SEARCH",
    "MEMORY_GRAPH_EXPANSION",
    "HEARTBEAT_DISABLE",
    "HEARTBEAT_PIN_CRASH_RESUME",
    "POOL_AFFINITY_ENFORCEMENT",
    "SCRIPTS_ONLY_MCP",
    "TASK_TOOL_PRELOAD_ENABLED",
    "PI_TOOL_DEFERRAL",
    "PI_CODEMODE",
    "PI_CODEMODE_MODELS",
    "OPENROUTER_APP_ATTRIBUTION",
    "CURSOR_NATIVE_SYSTEM_PROMPT",
    "SLACK_DISABLE",
    "CHAT_SDK_ENABLED",
    "SLACK_RENDER_V2",
    "SLACK_RENDER_V2_DELEGATION",
    "SLACK_BLOCK_EXTERNAL_CHANNELS",
    "GITHUB_DISABLE",
    "GITLAB_DISABLE",
    "AZURE_DEVOPS_DISABLE",
    "BITBUCKET_DISABLE",
    "LINEAR_DISABLE",
    "JIRA_DISABLE",
    "AGENTMAIL_DISABLE",
    "ADDITIVE_SLACK",
    "SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION",
    "RBAC_ENABLED",
    "SEED_AUTOMATIONS_ENABLED",
    "RBAC_AUDIT_DISABLED",
    "EXTENSION_ALLOW_INLINE_INSTALL",
    "BUDGET_ADMISSION_DISABLED",
    "MCP_OAUTH_ALLOW_PRIVATE_HOSTS",
    "OTEL_TRACE_POLL",
    "OTEL_EXPORT_API_LOGS",
    "ANONYMIZED_TELEMETRY",
    "SWARM_HIDE_CLOUD_PROMO",
    "DB_QUERY_BOUNDED_ENABLED",
    "CLAUDE_TRUST_PRESEED",
    "DB_RETENTION_DRY_RUN",
    "MODEL_AUTO_UPGRADE",
    "COMB_ENABLED",
  ]),
  ...enumValidator("SLACK_MODE", ["socket", "http"]),
  ...enumValidator("SLACK_THREAD_STEERING", ["off", "lead", "all"]),
  ...enumValidator("SLACK_THREAD_STEERING_MODE", ["steer", "queue"]),
  ...shortcodeValidators([
    "SLACK_REACTION_ACCEPTED",
    "SLACK_REACTION_BUFFERED",
    "SLACK_REACTION_NOW",
    "SLACK_REACTION_STEERED",
    "SLACK_REACTION_COMPLETED",
    "SLACK_REACTION_FAILED",
    "SLACK_STATUS_ICON_COMPLETED",
  ]),
  // Counts, minutes, and intervals: positive integers. Deliberately permissive
  // on the upper bound — an operator raising a sweep cap is legitimate.
  ...integerValidators(
    [
      "HEARTBEAT_INTERVAL_MS",
      "HEARTBEAT_STALL_THRESHOLD_MIN",
      "HEARTBEAT_STALL_NO_SESSION_MIN",
      "HEARTBEAT_STALL_STALE_HB_MIN",
      "HEARTBEAT_MAX_RESUME_GENERATIONS",
      "MEMORY_RECENCY_HALF_LIFE_DAYS",
      "RBAC_AUDIT_RETENTION_DAYS",
      "WORKFLOW_MAX_ITERATIONS",
      "WORKFLOW_MAX_STEPS_PER_RUN",
      "SCHEDULER_INTERVAL_MS",
      "EXTENSION_HANDLER_TIMEOUT_MS",
      "EXTENSION_MAX_CONSECUTIVE_FAILURES",
      "RUNTIME_STALE_THRESHOLD_MIN",
      "SCRIPT_RUN_CONCURRENCY_CAP",
      "WORKER_API_READY_TIMEOUT_SECONDS",
      "DB_QUERY_HTTP_BUDGET_MS",
      "DB_QUERY_HTTP_MAX_ROWS",
      "DB_QUERY_MCP_BUDGET_MS",
      "DB_QUERY_MCP_MAX_ROWS",
      "AGENT_FS_REQUEST_TIMEOUT_MS",
      "SLACK_CONCLUSION_SETTLE_SEC",
      "SLACK_CONCLUSION_TIMEOUT_MIN",
      "SLACK_TREE_STALL_MIN",
    ],
    1,
  ),
  // The retention tick's knobs are NOT merely positive. The sweep clamps each
  // to a distinct range and silently substitutes its default outside it, so a
  // permissive "integer >= 1" here accepted settings that never took effect:
  // an operator could save a 500ms tick budget, see it accepted, and have the
  // sweep keep running for the default 30000ms.
  ...boundedIntegerValidatorsFor(DB_RETENTION_TUNING_BOUNDS),
  ...boundedIntegerValidators(
    ["APPS_JSON_COLUMN_MAX_BYTES"],
    APPS_JSON_COLUMN_MAX_BYTES_BOUNDS.min,
    APPS_JSON_COLUMN_MAX_BYTES_BOUNDS.max,
  ),
  ...boundedIntegerValidators(
    ["CODEX_OAUTH_KEEP_WARM_MAX_AGE_HOURS"],
    CODEX_OAUTH_KEEP_WARM_MAX_AGE_HOURS_BOUNDS.min,
    CODEX_OAUTH_KEEP_WARM_MAX_AGE_HOURS_BOUNDS.max,
  ),
  ...boundedIntegerValidators(
    [
      "SESSION_LOG_RETENTION_DAYS",
      "AGENT_LOG_RETENTION_DAYS",
      "EVENTS_RETENTION_DAYS",
      // A kept-version count, not days. The floor of 1 is what guarantees the
      // sweep never deletes the newest version of any (agentId, field).
      "CONTEXT_VERSIONS_KEEP_LATEST",
    ],
    1,
    MAX_DB_RETENTION_DAYS,
  ),
  // 0 is meaningful here: "auto-assign nothing this sweep".
  ...integerValidators(["HEARTBEAT_MAX_AUTO_ASSIGN"], 0),
  // 0 disables the `latest:...@stable` soak window.
  ...integerValidators(["MODEL_LATEST_SOAK_DAYS"], 0),
  // 0 turns approval auto-cancellation off.
  ...integerValidators(["APPROVAL_REQUEST_AUTO_CANCELLATION_DAYS"], 0),
  // 0 turns the shutdown drain off; the shutdown path clamps to the same limit.
  ...boundedIntegerValidators(["API_DRAIN_MAX_MS"], 0, API_DRAIN_MAX_MS_LIMIT),
  // Chat SDK thread buffer window. 0 or an invalid value falls back to the 10 s
  // default in thread-buffer.ts; above 10 minutes a
  // reply waits longer than any operator expects.
  ...boundedIntegerValidators(["CHAT_SDK_BUFFER_MS"], 1, 600_000),
  // Minutes a Chat SDK thread keeps its owner after the owner's task ends.
  // 0 keeps it only while the task is open; a day is the longest useful window.
  ...boundedIntegerValidators(["CHAT_SDK_OWNER_WINDOW_MIN"], 0, 1440),
  // Below ~100 tokens the preamble can't fit a useful summary; above 20000
  // (~80k chars) it risks the SIGTERM-143 context-saturation failure mode
  // the cap exists to prevent (see context-preamble.ts).
  ...boundedIntegerValidators(["CONTEXT_PREAMBLE_MAX_TOKENS"], 100, 20000),
  MEMORY_MIN_SIMILARITY: (value) =>
    validateFloatRange("MEMORY_MIN_SIMILARITY", value, 0, 1, "between 0 and 1 inclusive"),
  MEMORY_ACCESS_BOOST_MAX: (value) =>
    validateFloatRange(
      "MEMORY_ACCESS_BOOST_MAX",
      value,
      1,
      Number.POSITIVE_INFINITY,
      "a number >= 1",
    ),
};

export function validateConfigValue(key: string, value: unknown): string | null {
  if (isTierConfigKey(key)) return validateTierConfigValue(key.toUpperCase(), value);
  const validator = VALIDATED_KEYS[key.toUpperCase()];
  return validator ? validator(value) : null;
}

/**
 * Every check `PUT /api/config` runs before a write: scope and scopeId shape,
 * reserved and internal keys, the per-key value validator and the env-export
 * rule. Shared with HITL `config` questions so the two writers cannot drift.
 */
export function validateConfigEntry(entry: {
  scope: "global" | "agent" | "repo";
  scopeId?: string | null;
  key: string;
  value: unknown;
  exportToEnv?: boolean;
}): string | null {
  if (entry.scope === "global" && entry.scopeId) return "Global scope must not have scopeId";
  if ((entry.scope === "agent" || entry.scope === "repo") && !entry.scopeId) {
    return "Agent/repo scope requires scopeId";
  }
  if (isReservedConfigKey(entry.key)) return reservedKeyError(entry.key).message;
  if (isInternalConfigKey(entry.key)) return internalConfigKeyError(entry.key).message;
  return (
    validateConfigValue(entry.key, entry.value) ?? validateExportToEnv(entry.key, entry.exportToEnv)
  );
}

/**
 * Rejects `exportToEnv: true` for keys only the API server reads. Omitting the
 * flag is fine: the write path stores false for those keys.
 */
export function validateExportToEnv(key: string, exportToEnv: boolean | undefined): string | null {
  return exportToEnv === true && isEnvExportRestrictedKey(key)
    ? envExportRestrictedError(key)
    : null;
}
