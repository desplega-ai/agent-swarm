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
const TOKEN_REGEXES: ReadonlyArray<{ name: string; re: RegExp }> = [
  // GitHub fine-grained PATs
  { name: "github_pat", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  // GitHub classic/OAuth tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // GitLab personal access tokens
  { name: "gitlab_pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  // Anthropic API keys (must match before the generic sk- rule below)
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI project keys
  { name: "openai_proj_key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  // OpenRouter keys
  { name: "openrouter_key", re: /\bsk-or-(?:v1-)?[A-Za-z0-9_-]{20,}\b/g },
  // Generic sk- legacy OpenAI keys (must come AFTER the ant/proj/or variants)
  { name: "sk_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // Slack tokens
  { name: "slack_token", re: /\bxox[baprseo]-[A-Za-z0-9-]{10,}\b/g },
  // AWS access key IDs
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API keys
  { name: "google_api_key", re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  // JWTs (3 dot-separated base64url segments)
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
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

function isSensitiveKey(key: string): boolean {
  if (NON_SECRET_EXCEPTIONS.has(key)) return false;
  if (SENSITIVE_KEY_EXACT.has(key)) return true;
  for (const suffix of SENSITIVE_KEY_SUFFIXES) {
    if (key.endsWith(suffix)) return true;
  }
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

  // Pass 2: structural patterns (catches secrets we never saw in env, e.g.
  // a token pasted into a tool_result by the operator or fetched from a
  // third-party API during a task).
  for (const { name, re } of TOKEN_REGEXES) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }

  return out;
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
