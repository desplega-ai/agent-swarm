// Pure helpers for deriving integration status from the swarm_config snapshot.
//
// Status semantics (see Plan: thoughts/taras/plans/2026-04-21-integrations-ui.md):
//   - "disabled"   — `<disableKey>` is set to a truthy value ("true" | "1" | "yes").
//   - "configured" — all required fields, or every key of one declared
//                    alternative, have a non-empty value present.
//   - "partial"    — a required or advanced field, or an alternative key, is
//                    present, but not a complete set.
//   - "none"       — none of those is present.
//
// Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) are filtered out
// defensively — they should never land in `swarm_config`, but if somehow a row
// appears we skip it so it can't influence status.

import type { SwarmConfig } from "@/api/types";
import {
  getIntegrationFields,
  type IntegrationConfigGroup,
  type IntegrationDef,
  type IntegrationField,
} from "./integrations-catalog";
import { resolveTranscriptionStatus } from "./transcription-status";

export type IntegrationStatus = "configured" | "partial" | "disabled" | "none";

/**
 * Map of env-var key → whether it's set in the API server's `process.env`.
 * Sourced from `GET /api/config/env-presence`. Empty when the endpoint has
 * not loaded yet — status derivation then falls back to DB-only presence.
 */
export type EnvPresence = Readonly<Record<string, boolean>>;

const RESERVED_KEYS: ReadonlySet<string> = new Set(["api_key", "secrets_encryption_key"]);

export const TRUTHY_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes"]);

/**
 * Effective values the env-presence map cannot carry. `chatSdkEnabled` comes
 * from `GET /api/integrations/chat/status` (`enabled`), which reads the value
 * the API runs with, so `CHAT_SDK_ENABLED=false` in the env is not enabled.
 */
export interface LiveIntegrationState {
  chatSdkEnabled?: boolean;
}

function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key.toLowerCase());
}

/**
 * Find the `SwarmConfig` row for a given key in the global scope.
 * Returns `undefined` if no row exists, the value is empty, or the key is
 * reserved (defense-in-depth).
 */
export function findConfigForKey(configs: SwarmConfig[], key: string): SwarmConfig | undefined {
  if (isReservedKey(key)) return undefined;
  return configs.find((c) => c.scope === "global" && c.key === key && c.value.length > 0);
}

/**
 * Derive an integration's status from the global `swarm_config` snapshot.
 *
 * Precedence:
 *   1. If `disableKey` resolves to a truthy value → "disabled".
 *   2. If all required fields are present → "configured".
 *   3. If every key of one declared alternative is present → "configured".
 *   4. If a required or advanced field, or any alternative key, is present →
 *      "partial".
 *   5. Otherwise → "none".
 *
 * Optional metadata (a bot name, a base URL) never makes an integration
 * "configured" on its own. Credential sets used instead of the required
 * fields, like GitHub App mode or the Codex OAuth row, are declared as
 * `alternatives` on the def.
 */
function isKeyPresent(key: string, configs: SwarmConfig[], envPresence: EnvPresence): boolean {
  if (key.endsWith("*")) {
    const prefix = key.slice(0, -1);
    return configs.some(
      (c) => c.scope === "global" && c.key.startsWith(prefix) && c.value.length > 0,
    );
  }
  if (isReservedKey(key)) return false;
  if (findConfigForKey(configs, key) !== undefined) return true;
  return envPresence[key] === true;
}

function isFieldPresent(
  field: IntegrationField,
  configs: SwarmConfig[],
  envPresence: EnvPresence,
): boolean {
  return [field.key, ...(field.aliasKeys ?? [])].some((key) =>
    isKeyPresent(key, configs, envPresence),
  );
}

export function deriveIntegrationStatus(
  def: IntegrationDef,
  configs: SwarmConfig[],
  envPresence: EnvPresence = {},
  live: LiveIntegrationState = {},
): IntegrationStatus {
  // Disabled signal: only derivable from DB rows (env-presence is boolean-only,
  // so we can't tell <PREFIX>_DISABLE=true from =false when set via deploy env).
  if (def.disableKey) {
    const disableCfg = findConfigForKey(configs, def.disableKey);
    if (disableCfg && TRUTHY_VALUES.has(disableCfg.value.trim().toLowerCase())) {
      return "disabled";
    }
  }

  if (def.id === "slack") {
    const configuredMode = findConfigForKey(configs, "SLACK_MODE")?.value.trim();
    // Env presence cannot reveal the selected transport; do not guess readiness.
    if (!configuredMode && envPresence.SLACK_MODE) return "partial";
    const mode = configuredMode ?? "socket";
    if (mode !== "socket" && mode !== "http") return "partial";
    const bot = isKeyPresent("SLACK_BOT_TOKEN", configs, envPresence);
    const credential = isKeyPresent(
      mode === "http" ? "SLACK_SIGNING_SECRET" : "SLACK_APP_TOKEN",
      configs,
      envPresence,
    );
    if (bot && credential) return "configured";
    return bot || credential ? "partial" : "none";
  }

  if (def.id === "chat-sdk") return deriveChatSdkStatus(configs, envPresence, live);

  // Configured by an explicit key or by a provider key the swarm already has.
  if (def.id === "transcription") {
    return resolveTranscriptionStatus(configs, envPresence) ? "configured" : "none";
  }

  const groups = def.configGroups ?? [];
  if (groups.length > 0) {
    return deriveGroupedStatus(groups, configs, envPresence);
  }

  const fields = getIntegrationFields(def);
  const requiredFields = fields.filter((f) => f.required === true);
  const alternatives = def.alternatives ?? [];

  if (
    requiredFields.length > 0 &&
    requiredFields.every((f) => isFieldPresent(f, configs, envPresence))
  ) {
    return "configured";
  }
  if (
    alternatives.some(
      (alt) =>
        alt.keys.length > 0 && alt.keys.every((key) => isKeyPresent(key, configs, envPresence)),
    )
  ) {
    return "configured";
  }

  // Only optional fields and no alternatives: any value set is the whole setup.
  if (requiredFields.length === 0 && alternatives.length === 0) {
    return fields.some((f) => isFieldPresent(f, configs, envPresence)) ? "configured" : "none";
  }

  // Started but incomplete: a required or advanced field, or part of an
  // alternative. Advanced metadata alone (a bot name) is never "configured".
  const started =
    fields.some(
      (f) =>
        (f.required === true || f.advanced === true) && isFieldPresent(f, configs, envPresence),
    ) ||
    alternatives.some((alt) => alt.keys.some((key) => isKeyPresent(key, configs, envPresence)));
  return started ? "partial" : "none";
}

function deriveGroupedStatus(
  groups: IntegrationConfigGroup[],
  configs: SwarmConfig[],
  envPresence: EnvPresence,
): IntegrationStatus {
  let hasAnyRequiredPresent = false;
  let hasAnyFieldPresent = false;
  let hasAnyRequiredGroup = false;

  for (const group of groups) {
    const fields = group.fields.filter((f) => !isReservedKey(f.key));
    const requiredFields = fields.filter((f) => f.required === true);
    if (requiredFields.length > 0) {
      hasAnyRequiredGroup = true;
    }
    const requiredPresentCount = requiredFields.reduce(
      (acc, f) => acc + (isFieldPresent(f, configs, envPresence) ? 1 : 0),
      0,
    );

    if (fields.some((f) => isFieldPresent(f, configs, envPresence))) {
      hasAnyFieldPresent = true;
    }
    if (requiredPresentCount > 0) {
      hasAnyRequiredPresent = true;
    }
    if (requiredFields.length > 0 && requiredPresentCount === requiredFields.length) {
      return "configured";
    }
    if (requiredFields.length === 0 && hasAnyFieldPresent) {
      return "configured";
    }
  }

  if (!hasAnyFieldPresent) return "none";
  if (hasAnyRequiredGroup) return hasAnyRequiredPresent ? "partial" : "none";
  return "configured";
}

/**
 * Chat SDK: `configured` when `CHAT_SDK_ENABLED` is true and
 * `CHAT_SDK_ADAPTERS` parses to a non-empty object, `partial` when only one
 * of them is set. Env presence cannot show a value, so an env-only
 * `CHAT_SDK_ENABLED` counts as enabled only when the live status says so.
 * Until the live status loads, presence is the fallback.
 */
function deriveChatSdkStatus(
  configs: SwarmConfig[],
  envPresence: EnvPresence,
  live: LiveIntegrationState,
): IntegrationStatus {
  const enabledRow = findConfigForKey(configs, "CHAT_SDK_ENABLED");
  const enabled = enabledRow
    ? TRUTHY_VALUES.has(enabledRow.value.trim().toLowerCase())
    : envPresence.CHAT_SDK_ENABLED === true && live.chatSdkEnabled !== false;
  const adaptersRow = findConfigForKey(configs, "CHAT_SDK_ADAPTERS");
  const adapters = adaptersRow
    ? isNonEmptyJsonObject(adaptersRow.value)
    : envPresence.CHAT_SDK_ADAPTERS === true;
  if (enabled && adapters) return "configured";
  return enabled || adapters ? "partial" : "none";
}

function isNonEmptyJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0
    );
  } catch {
    return false;
  }
}
