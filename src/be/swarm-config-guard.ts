import { ProviderNameSchema } from "../types";

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
 * Matching is case-insensitive so `api_key`, `Api_Key`, etc. are all
 * rejected at every write path (DB helpers, HTTP routes, MCP tools).
 */
const RESERVED_KEYS = new Set(["API_KEY", "SECRETS_ENCRYPTION_KEY"]);

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
  const message = `Invalid ${key} value (must be one of: ${options.join(", ")})`;
  return {
    [key]: (value: unknown) => {
      if (typeof value !== "string") return message;
      return options.includes(value.trim()) ? null : message;
    },
  };
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

const VALIDATED_KEYS: Record<string, ConfigValidator> = {
  HARNESS_PROVIDER: (value) => {
    const parsed = ProviderNameSchema.safeParse(value);
    if (parsed.success) return null;
    return `Invalid HARNESS_PROVIDER value (must be one of: ${ProviderNameSchema.options.join(", ")})`;
  },
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
  //   bearer — explicit bearer token via AWS_BEARER_TOKEN_BEDROCK (future/Mantle)
  // When absent the worker infers the mode from MODEL_OVERRIDE (sdk semantics).
  BEDROCK_AUTH_MODE: (value) => {
    if (value === "sdk" || value === "bearer") return null;
    return "Invalid BEDROCK_AUTH_MODE value (must be one of: sdk, bearer)";
  },
  ...booleanValidators([
    "STEERING_ENABLED",
    "MEMORY_HYBRID_SEARCH",
    "MEMORY_GRAPH_EXPANSION",
    "HEARTBEAT_DISABLE",
    "HEARTBEAT_PIN_CRASH_RESUME",
    "POOL_AFFINITY_ENFORCEMENT",
    "SCRIPTS_ONLY_MCP",
    "SLACK_DISABLE",
    "SLACK_RENDER_V2",
    "GITHUB_DISABLE",
    "GITLAB_DISABLE",
    "LINEAR_DISABLE",
    "JIRA_DISABLE",
    "AGENTMAIL_DISABLE",
    "ADDITIVE_SLACK",
    "SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION",
    "RBAC_ENABLED",
    "RBAC_AUDIT_DISABLED",
    "BUDGET_ADMISSION_DISABLED",
    "MCP_OAUTH_ALLOW_PRIVATE_HOSTS",
    "OTEL_TRACE_POLL",
    "ANONYMIZED_TELEMETRY",
    "SWARM_HIDE_CLOUD_PROMO",
  ]),
  ...enumValidator("SLACK_THREAD_STEERING", ["lead", "all"]),
  ...enumValidator("SLACK_THREAD_STEERING_MODE", ["steer", "queue"]),
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
      "SCRIPT_RUN_CONCURRENCY_CAP",
      "WORKER_API_READY_TIMEOUT_SECONDS",
    ],
    1,
  ),
  // 0 is meaningful here: "auto-assign nothing this sweep".
  ...integerValidators(["HEARTBEAT_MAX_AUTO_ASSIGN"], 0),
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
  const validator = VALIDATED_KEYS[key.toUpperCase()];
  return validator ? validator(value) : null;
}
