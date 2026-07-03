/**
 * Runtime secret scrubber for log/stdout/stderr emission.
 *
 * Exported `scrubSecrets(text)` replaces known sensitive values with
 * `[REDACTED:<name>]` placeholders. Used at every text-egress point (adapter
 * log files, session-log uploads, pretty-printed stdout, stderr dumps) so
 * credentials set via `swarm_config` or container env never leak into
 * /workspace/logs/*.jsonl, the `session_logs` SQLite table, or container
 * stdout shipped to log aggregators.
 *
 * Two sources are combined:
 *   1. `process.env` values of known-sensitive keys (either exact names or
 *      suffix-matched like *_API_KEY, *_TOKEN, *_SECRET). These are the
 *      concrete strings the worker actually holds.
 *   2. Structural regex patterns for well-known token shapes (GitHub PATs,
 *      OpenAI keys, Slack tokens, JWTs, …). Covers cases where a secret
 *      arrived via a tool result without ever being in our env.
 *
 * This module is deliberately worker/API neutral — it reads only from
 * `process.env` so it can be imported from both sides without violating the
 * API↔worker DB boundary (scripts/check-db-boundary.sh).
 */

/** Env-var names that are always considered secrets, even without suffix hints. */
const SENSITIVE_KEY_EXACT = new Set<string>([
  "API_KEY",
  "SECRETS_ENCRYPTION_KEY",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_SECRET",
  "SLACK_USER_TOKEN",
  "SLACK_APP_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "VERCEL_TOKEN",
  "RESEND_API_KEY",
  "AGENTMAIL_API_KEY",
  "API_AGENT_FS_API_KEY",
  "AGENT_FS_API_KEY",
  "BUSINESS_USE_API_KEY",
  "QA_USE_API_KEY",
  "DOCS_API_KEY",
  "DOKPLOY_API_KEY",
  "DEVTO_API_KEY",
  "ELEVENLABS_API_KEY",
  "ENGINY_API_KEY",
  "OPENFORT_API_KEY",
  "OPENFORT_TEST_SECRET_KEY",
  "OPENFORT_TEST_WALLET_PRIVATE_KEY",
  "OPENFORT_WALLET_SECRET",
  "TURSO_API_TOKEN",
  "TURSO_DB_TOKEN",
  "TURSO_X_POSTS_DB_TOKEN",
  "BROWSER_USE_API_KEY",
  "PLAUSIBLE_API_KEY",
  "IMGFLIP_PASSWORD",
  "GSC_SERVICE_ACCOUNT_BASE64",
  "LINEAR_API_KEY",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "SIGNOZ_INGESTION_KEY",
]);

/** Suffixes that mark an env-var value as sensitive by convention. */
const SENSITIVE_KEY_SUFFIXES = ["_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_PRIVATE_KEY"];

/** Keys that match the sensitive suffix heuristic but are actually safe URLs/configs. */
const NON_SECRET_EXCEPTIONS = new Set<string>([
  "MCP_BASE_URL",
  "APP_URL",
  "API_URL",
  "TEMPLATE_REGISTRY_URL",
]);

/**
 * Minimum length for an env-var value to be considered scrub-worthy.
 * Short values (< 12 chars) cause false-positive replacements across
 * legitimate log content (e.g. a 6-char password would collide with a user
 * name). For short secrets we rely on the regex pass only.
 */
const MIN_VALUE_LENGTH = 12;

/**
 * Structural regex patterns for common credential shapes. Applied AFTER the
 * env-value substitution pass so env-sourced replacements keep their
 * human-readable `[REDACTED:<KEY_NAME>]` labels instead of the generic
 * pattern name.
 *
 * Order matters when one pattern is a prefix of another (e.g. `sk-ant-` must
 * match before the more general `sk-`).
 */

// Leading word boundary that also matches after JSON escape sequences (\n, \t,
// \r, etc.) where the trailing char is alphanumeric and defeats standard \b.
const TB = String.raw`(?:(?<=\\[nrtbfu0])|(?<!\w))`;

const TOKEN_REGEXES: ReadonlyArray<{ name: string; re: RegExp }> = [
  // GitHub fine-grained PATs
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  // GitHub classic/OAuth tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  { name: "github_token", re: new RegExp(String.raw`${TB}gh[pousr]_[A-Za-z0-9]{20,}\b`, "g") },
  // GitLab personal access tokens
  { name: "gitlab_pat", re: new RegExp(String.raw`${TB}glpat-[A-Za-z0-9_-]{20,}\b`, "g") },
  // Anthropic API keys (must match before the generic sk- rule below)
  { name: "anthropic_key", re: new RegExp(String.raw`${TB}sk-ant-[A-Za-z0-9_-]{20,}\b`, "g") },
  // OpenAI project keys
  { name: "openai_proj_key", re: new RegExp(String.raw`${TB}sk-proj-[A-Za-z0-9_-]{20,}\b`, "g") },
  // OpenRouter keys
  {
    name: "openrouter_key",
    re: new RegExp(String.raw`${TB}sk-or-(?:v1-)?[A-Za-z0-9_-]{20,}\b`, "g"),
  },
  // Generic sk- legacy OpenAI keys (must come AFTER the ant/proj/or variants)
  { name: "sk_key", re: new RegExp(String.raw`${TB}sk-[A-Za-z0-9]{20,}\b`, "g") },
  // Slack tokens
  { name: "slack_token", re: new RegExp(String.raw`${TB}xox[baprseo]-[A-Za-z0-9-]{10,}\b`, "g") },
  // AWS access key IDs
  { name: "aws_access_key", re: new RegExp(String.raw`${TB}AKIA[0-9A-Z]{16}\b`, "g") },
  // Google API keys
  { name: "google_api_key", re: new RegExp(String.raw`${TB}AIza[A-Za-z0-9_-]{35}\b`, "g") },
  // JWTs (3 dot-separated base64url segments)
  {
    name: "jwt",
    re: new RegExp(
      String.raw`${TB}eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
      "g",
    ),
  },
  // SigNoz Cloud OTLP auth header values.
  {
    name: "signoz_ingestion_key",
    re: new RegExp(String.raw`${TB}signoz-ingestion-key=[A-Za-z0-9._~+/-]{20,}={0,2}\b`, "g"),
  },
  // Linear OAuth tokens and API keys
  { name: "linear_oauth", re: new RegExp(String.raw`${TB}lin_oauth_[A-Za-z0-9_-]{10,}\b`, "g") },
  { name: "linear_api", re: new RegExp(String.raw`${TB}lin_api_[A-Za-z0-9_-]{10,}\b`, "g") },
  // npm tokens
  { name: "npm_token", re: new RegExp(String.raw`${TB}npm_[A-Za-z0-9_-]{20,}\b`, "g") },
  // Jira API tokens (Atlassian cloud)
  {
    name: "atlassian_token",
    re: new RegExp(String.raw`${TB}ATATT[A-Za-z0-9_-]{20,}\b`, "g"),
  },
  // Agent-swarm MCP user tokens (`aswt_<base62-20+>`). Schema lands in
  // migration 064; mint/revoke endpoints ship with the MCP-token plan.
  // Rule lives here now so plaintexts never leak into logs once endpoints
  // come online.
  { name: "mcp_token", re: new RegExp(String.raw`${TB}aswt_[A-Za-z0-9]{20,}\b`, "g") },
];

interface EnvValueEntry {
  value: string;
  name: string;
}

interface ScrubCache {
  entries: EnvValueEntry[];
  snapshotKey: string;
}

let cache: ScrubCache | null = null;
const volatileSecrets = new Map<string, string>();

/** Fingerprint current env so we can invalidate cache cheaply when it changes. */
function snapshotEnv(): string {
  const parts: string[] = [];
  for (const key of Object.keys(process.env).sort()) {
    if (!isSensitiveKey(key)) continue;
    const v = process.env[key];
    if (!v) continue;
    parts.push(`${key}=${v.length}`);
  }
  return parts.join("|");
}

export function isSensitiveKey(key: string): boolean {
  if (NON_SECRET_EXCEPTIONS.has(key)) return false;
  if (SENSITIVE_KEY_EXACT.has(key)) return true;
  for (const suffix of SENSITIVE_KEY_SUFFIXES) {
    if (key.endsWith(suffix)) return true;
  }
  // Codex OAuth pool credentials: codex_oauth (legacy) + codex_oauth_0…N (pool slots).
  // The outer JSON structure (accountId, expires) isn't covered by TOKEN_REGEXES.
  if (/^codex_oauth(_\d+)?$/.test(key)) return true;
  return false;
}

function buildCache(): ScrubCache {
  const entries: EnvValueEntry[] = [];
  const seen = new Set<string>();

  for (const [key, rawValue] of Object.entries(process.env)) {
    if (!rawValue) continue;
    if (!isSensitiveKey(key)) continue;

    // Credential pools: a single env var may hold a comma-separated list of
    // tokens that the runner rotates through. Scrub each component too.
    const candidates = rawValue.includes(",")
      ? [rawValue, ...rawValue.split(",").map((s) => s.trim())]
      : [rawValue];

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate.length < MIN_VALUE_LENGTH) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      entries.push({ value: candidate, name: key });
    }
  }

  // Replace longer values before shorter ones so prefix-overlapping secrets
  // don't mangle each other (rare but possible with pool values).
  entries.sort((a, b) => b.value.length - a.value.length);

  return { entries, snapshotKey: snapshotEnv() };
}

function getCache(): ScrubCache {
  const current = snapshotEnv();
  if (!cache || cache.snapshotKey !== current) {
    cache = buildCache();
  }
  return cache;
}

/**
 * Replace known secret values in `text` with `[REDACTED:<name>]` markers.
 * Null/undefined inputs return an empty string. Empty strings pass through.
 */
export function scrubSecrets(text: string | null | undefined): string {
  if (text == null) return "";
  if (text.length === 0) return text;

  let out = text;

  // Pass 1: exact-match env values (preserves the env-var name in the marker
  // for debugging).
  const { entries } = getCache();
  for (const { value, name } of entries) {
    if (out.includes(value)) {
      // split/join is O(n) and faster than building a RegExp for every value.
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }

  for (const [value, name] of volatileSecrets) {
    if (out.includes(value)) {
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }

  // Pass 2: structural patterns (catches secrets we never saw in env, e.g.
  // a token pasted into a tool_result by the operator or fetched from a
  // third-party API during a task).
  for (const { name, re } of TOKEN_REGEXES) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }

  return out;
}

export function scrubObject<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubSecrets(value) as T;
  if (typeof value !== "object") return value;

  if (seen.has(value)) {
    return "[Circular]" as T;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubObject(item, seen)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrubObject(child, seen);
  }
  return out as T;
}

/**
 * Force the env-value cache to rebuild on the next scrub call. Callers should
 * invoke this whenever the swarm_config is reloaded (`/internal/reload-config`
 * on the API, credential-selection on the worker) so new secrets get covered
 * immediately.
 */
export function refreshSecretScrubberCache(): void {
  cache = null;
}

/**
 * Register a runtime-fetched secret that is not present in process.env.
 *
 * Use this before returning short-lived tokens through an API/tool result so
 * follow-on logs, telemetry previews, and session-log egress can redact the
 * concrete value even though the caller still receives it.
 */
export function registerVolatileSecret(value: string, name: string): void {
  if (value.length < MIN_VALUE_LENGTH) return;
  volatileSecrets.set(value, name);
}

export function clearVolatileSecretsForTesting(): void {
  volatileSecrets.clear();
}
