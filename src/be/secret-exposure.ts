import type { SecretExposure } from "../types";

/**
 * Per-key secret exposure: which principals may read a swarm_config secret
 * value over HTTP.
 *
 * - `worker`: any agent. Harness credentials and tools a worker runs.
 * - `lead`: the lead, the operator and users with `config.read.secrets`.
 *   Integration and admin credentials the API itself uses.
 * - `api`: nobody over HTTP. The API reads these into its own process.env.
 *
 * A row's stored `exposure` overrides the key default, except for the `api`
 * keys below, which stay pinned. Unknown keys fall back to
 * SECRET_EXPOSURE_DEFAULT.
 */

/**
 * D1: exposure for a key with no stored override and no registry default.
 * `worker` keeps every existing deployment working. Flip here, or per
 * deployment with SECRET_EXPOSURE_DEFAULT.
 */
export const DEFAULT_UNKNOWN_SECRET_EXPOSURE: Exclude<SecretExposure, "api"> = "worker";

/**
 * D2: exposure stamped on INSERT of a secret row whose key has no registry
 * default and whose writer gave none. An UPDATE never stamps.
 */
export const NEW_UNKNOWN_SECRET_EXPOSURE: SecretExposure = "lead";

const WORKER_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "codex_oauth",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "DASHSCOPE_API_KEY",
  "KIRO_API_KEY",
  "CURSOR_API_KEY",
  "AMP_API_KEY",
  "DEVIN_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_BEARER_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_EXT_PAT",
  "AGENTMAIL_API_KEY",
  "AGENT_FS_API_KEY",
  "COMPOSIO_API_KEY",
  "E2B_API_KEY",
  "SENTRY_AUTH_TOKEN",
];

const LEAD_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITLAB_WEBHOOK_SECRET",
  "AZURE_DEVOPS_WEBHOOK_SECRET",
  "LINEAR_API_KEY",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_SIGNING_SECRET",
  "JIRA_CLIENT_SECRET",
  "JIRA_WEBHOOK_TOKEN",
  "AGENTMAIL_WEBHOOK_SECRET",
  "KAPSO_API_KEY",
  "KAPSO_WEBHOOK_HMAC_SECRET",
  "EMBEDDING_API_KEY",
  "OPENAI_DECISIONS_API_KEY",
  "SIGNOZ_INGESTION_KEY",
  "OPENFORT_API_KEY",
  "OPENFORT_WALLET_SECRET",
  "EVM_PRIVATE_KEY",
  "LAYA_API_KEY",
  "TYPESAFE_API_KEY",
  "BUSINESS_USE_API_KEY",
  "SUPERAGENT_WEBHOOK_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "COMPOSIO_ORG_API_KEY",
  "MANAGED_GITHUB_TOKEN",
];

/** Keys the API owns for its own use. Pinned: a row override cannot widen them. */
const API_KEYS = ["API_AGENT_FS_API_KEY", "SLACK_SIGNING_SECRET"];

export const SECRET_EXPOSURE_DEFAULTS: ReadonlyMap<string, SecretExposure> = new Map([
  ...WORKER_KEYS.map((key) => [key, "worker"] as const),
  ...LEAD_KEYS.map((key) => [key, "lead"] as const),
  ...API_KEYS.map((key) => [key, "api"] as const),
]);

const SECRET_EXPOSURE_PATTERNS: ReadonlyArray<readonly [RegExp, SecretExposure]> = [
  // Multi-slot codex OAuth credentials (src/providers/codex-oauth/storage.ts).
  [/^codex_oauth_\d+$/, "worker"],
  // Script-connection secrets, resolved server-side by credential bindings.
  [/^connection\.[^.]+\.secret$/, "lead"],
];

/** The code default for a key, or null when the registry does not know it. */
export function registryExposureFor(key: string): SecretExposure | null {
  const exact = SECRET_EXPOSURE_DEFAULTS.get(key);
  if (exact) return exact;
  for (const [pattern, exposure] of SECRET_EXPOSURE_PATTERNS) {
    if (pattern.test(key)) return exposure;
  }
  return null;
}

/** Read on every call so a stored global config change applies after reload. */
export function unknownSecretExposureDefault(): Exclude<SecretExposure, "api"> {
  const raw = process.env.SECRET_EXPOSURE_DEFAULT?.trim().toLowerCase();
  return raw === "worker" || raw === "lead" ? raw : DEFAULT_UNKNOWN_SECRET_EXPOSURE;
}

/** True for the registry's API-only keys; a stored row value never changes this. */
export function isPinnedApiKey(key: string): boolean {
  return registryExposureFor(key) === "api";
}

/** Parse a stored column value; anything outside the enum reads as NULL. */
export function parseStoredExposure(value: unknown): SecretExposure | null {
  return value === "worker" || value === "lead" || value === "api" ? value : null;
}

/**
 * The exposure that applies to a row: pinned `api` keys first, then the stored
 * override, then the registry default, then SECRET_EXPOSURE_DEFAULT.
 */
export function secretExposureFor(row: {
  key: string;
  exposure?: SecretExposure | null;
}): SecretExposure {
  if (isPinnedApiKey(row.key)) return "api";
  return row.exposure ?? registryExposureFor(row.key) ?? unknownSecretExposureDefault();
}

/**
 * Exposure to store on INSERT. An explicit value wins, including an explicit
 * null (code default). Otherwise a secret row whose key has no registry
 * default gets NEW_UNKNOWN_SECRET_EXPOSURE, and everything else stays NULL.
 */
export function exposureToStampOnInsert(data: {
  key: string;
  isSecret: boolean;
  exposure?: SecretExposure | null;
}): SecretExposure | null {
  if (data.exposure !== undefined) return data.exposure;
  if (data.isSecret && registryExposureFor(data.key) === null) return NEW_UNKNOWN_SECRET_EXPOSURE;
  return null;
}

/** Reject a write that tries to widen a pinned `api` key. */
export function validateExposureWrite(
  key: string,
  exposure: SecretExposure | null | undefined,
): string | null {
  if (exposure && exposure !== "api" && isPinnedApiKey(key)) {
    return `Config key '${key}' is API-only; its exposure cannot be set to '${exposure}'.`;
  }
  return null;
}
