import { deleteKv, getKv, getSwarmConfigs, upsertKv } from "@/be/db";

/**
 * Native Kapso/WhatsApp integration — shared server-side config + mapping store.
 *
 * The mapping (phone-number-id → routing target) is backed by the swarm KV store
 * under a pinned namespace, NOT a dedicated table. The inbound webhook handler and
 * the `register-kapso-number` MCP tool are the only readers/writers.
 */

/** Pinned KV namespace for phone-number → routing mappings. No TTL. */
export const KAPSO_NUMBERS_NAMESPACE = "integrations:kapso:numbers";

/** Pinned KV namespace for inbound message-id dedupe markers (24h TTL). */
export const KAPSO_DEDUPE_NAMESPACE = "integrations:kapso:dedupe";

/** How long a dedupe marker lives — long enough to cover Kapso's webhook retries. */
export const KAPSO_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default Kapso API host when `KAPSO_API_BASE_URL` is unset (host only, no path). */
export const DEFAULT_KAPSO_API_BASE_URL = "https://api.kapso.ai";

/** A registered phone number and where its inbound messages should route. */
export interface KapsoNumberMapping {
  phoneNumberId: string;
  /** Route inbound to this agent as a task. */
  agentId?: string;
  /** Advanced override: dispatch via this workflow's webhook trigger instead of a task. */
  workflowId?: string;
  /** Human-friendly display name for the number. */
  name?: string;
  createdAt: string;
}

export interface KapsoConfig {
  apiKey: string | undefined;
  apiBaseUrl: string;
  webhookHmacSecret: string | undefined;
  phoneNumberId: string | undefined;
}

/**
 * Read a swarm-config value (global scope) by key, falling back to the process
 * env. Decryption happens inside `getSwarmConfigs`.
 */
function readConfigValue(key: string): string | undefined {
  const found = getSwarmConfigs({ scope: "global", key }).find(
    (c) => typeof c.value === "string" && c.value.length > 0,
  );
  if (found) return found.value;
  const env = process.env[key];
  return env && env.length > 0 ? env : undefined;
}

/** Resolve the Kapso integration config from swarm config (env fallback). */
export function getKapsoConfig(): KapsoConfig {
  const base = readConfigValue("KAPSO_API_BASE_URL") ?? DEFAULT_KAPSO_API_BASE_URL;
  return {
    apiKey: readConfigValue("KAPSO_API_KEY"),
    apiBaseUrl: base.replace(/\/+$/, ""),
    webhookHmacSecret: readConfigValue("KAPSO_WEBHOOK_HMAC_SECRET"),
    phoneNumberId: readConfigValue("KAPSO_PHONE_NUMBER_ID"),
  };
}

/** Look up the routing mapping for a phone-number-id, or null if unregistered. */
export function getKapsoNumberMapping(phoneNumberId: string): KapsoNumberMapping | null {
  const row = getKv(KAPSO_NUMBERS_NAMESPACE, phoneNumberId);
  return row ? (row.value as KapsoNumberMapping) : null;
}

/** Upsert a routing mapping (no TTL). */
export function putKapsoNumberMapping(mapping: KapsoNumberMapping): KapsoNumberMapping {
  upsertKv({
    namespace: KAPSO_NUMBERS_NAMESPACE,
    key: mapping.phoneNumberId,
    value: mapping,
    valueType: "json",
    expiresAt: null,
  });
  return mapping;
}

/** Delete a routing mapping. Returns true if a row was removed. */
export function deleteKapsoNumberMapping(phoneNumberId: string): boolean {
  return deleteKv(KAPSO_NUMBERS_NAMESPACE, phoneNumberId);
}

/**
 * Record a message-id as processed. Returns true the FIRST time a given id is
 * seen and false on every subsequent delivery within the TTL window — so the
 * caller drops duplicates (Kapso retries deliveries).
 */
export function markKapsoMessageSeen(messageId: string): boolean {
  if (getKv(KAPSO_DEDUPE_NAMESPACE, messageId)) return false;
  upsertKv({
    namespace: KAPSO_DEDUPE_NAMESPACE,
    key: messageId,
    value: 1,
    valueType: "integer",
    expiresAt: Date.now() + KAPSO_DEDUPE_TTL_MS,
  });
  return true;
}
