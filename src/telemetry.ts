/**
 * Anonymized telemetry for agent-swarm.
 *
 * - Opt-out via ANONYMIZED_TELEMETRY=false
 * - Fire-and-forget: never throws, never blocks
 * - No external dependencies (uses global fetch + node:crypto)
 * - Importable from both API server and workers
 */
import { randomUUID } from "node:crypto";

const TELEMETRY_ENDPOINT = "https://proxy.desplega.sh/v1/events";
const PRODUCT = "agent-swarm";
const TIMEOUT_MS = 5_000;

let installationId: string | null = null;
let source = "unknown";
let cachedIsCloud = false;

function isEnabled(): boolean {
  return process.env.ANONYMIZED_TELEMETRY !== "false";
}

/**
 * Hosts we own that indicate a cloud-pointed install. Exact-match for known
 * hostnames + suffix-match for the cloud apexes so future cloud subdomains
 * (`mcp.agent-swarm.dev`, `api.agent-swarm.cloud`, etc.) are automatically
 * classified as cloud. Substring match is intentionally avoided —
 * `agent-swarm.dev.attacker.com` must NOT be treated as cloud.
 */
const CLOUD_HOST_EXACT = new Set<string>([
  "agent-swarm-mcp.desplega.sh",
  "agent-swarm.dev",
  "agent-swarm.cloud",
]);
const CLOUD_HOST_SUFFIXES = [".agent-swarm.dev", ".agent-swarm.cloud"];

function isCloudHostname(hostname: string): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  if (CLOUD_HOST_EXACT.has(normalized)) return true;
  return CLOUD_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Parse `MCP_BASE_URL` (or any candidate URL) into the cloud flag we ship on
 * every telemetry event. URL parsing — not substring match — so we never
 * confuse an attacker-controlled `agent-swarm.dev.bad` for cloud. On any
 * parse failure returns a safe `false` so callers never need to defend
 * against this throwing.
 *
 * The hostname itself is intentionally NOT emitted — telemetry is anonymous,
 * and leaking the deployment host would defeat that. Only the boolean
 * cloud-cohort flag ships.
 *
 * Exported for tests; not part of the public API.
 */
export function _resolveCloudMode(mcpBaseUrl: string | undefined | null): {
  isCloud: boolean;
} {
  if (!mcpBaseUrl) return { isCloud: false };
  let hostname: string;
  try {
    hostname = new URL(mcpBaseUrl).hostname;
  } catch {
    return { isCloud: false };
  }
  if (!hostname) return { isCloud: false };
  return { isCloud: isCloudHostname(hostname) };
}

interface InitTelemetryOptions {
  /**
   * Whether to mint and persist a new install ID when the config read returns
   * nothing (or fails). Only the api-server should set this — it owns the
   * install identity. Workers piggyback on whatever the api-server has
   * persisted; if it's not there yet, the worker silently no-ops telemetry to
   * avoid polluting metrics with ephemeral per-restart IDs.
   *
   * Default: false.
   */
  generateIfMissing?: boolean;
}

/**
 * Initialize telemetry. Call once at startup.
 * @param sourceId - "api-server" or "worker"
 * @param getConfig - reads a key from swarm_config (global scope)
 * @param setConfig - writes a key to swarm_config (global scope)
 * @param options - see {@link InitTelemetryOptions}
 */
export async function initTelemetry(
  sourceId: string,
  getConfig: (key: string) => Promise<string | undefined> | string | undefined,
  setConfig: (key: string, value: string) => Promise<void> | void,
  options: InitTelemetryOptions = {},
): Promise<void> {
  if (!isEnabled()) return;
  source = sourceId;
  const generateIfMissing = options.generateIfMissing === true;

  const resolved = _resolveCloudMode(process.env.MCP_BASE_URL);
  cachedIsCloud = resolved.isCloud;
  console.log(`telemetry: cloud=${cachedIsCloud}`);

  try {
    const existing = await getConfig("telemetry_installation_id");
    if (existing) {
      installationId = existing;
    } else if (generateIfMissing) {
      installationId = `install_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await setConfig("telemetry_installation_id", installationId);
    }
    // else: leave installationId = null; track() will no-op
  } catch {
    // Config access failed.
    if (generateIfMissing) {
      // Generate ephemeral ID so telemetry still works this session.
      installationId = `ephemeral_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    }
    // else: leave installationId = null; track() will no-op
  }
}

interface TrackOptions {
  event: string;
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Read SWARM_ORG_ID / SWARM_ORG_NAME from process.env at call time. Reading
 * fresh each track() lets reloaded swarm_config values land in telemetry
 * without restarting (loadGlobalConfigsIntoEnv mutates process.env on
 * `POST /api/config/reload` with override=true). Returns only the keys that
 * are set, so the spread below stays a clean noop on self-host.
 */
function getOrgIdentity(): { organization_id?: string; organization_name?: string } {
  const out: { organization_id?: string; organization_name?: string } = {};
  const orgId = process.env.SWARM_ORG_ID?.trim();
  if (orgId) out.organization_id = orgId;
  const orgName = process.env.SWARM_ORG_NAME?.trim();
  if (orgName) out.organization_name = orgName;
  return out;
}

/**
 * Mirror of `buildIdentity()`'s SWARM_CLOUD parsing — accepts "true" or "1".
 * Always emitted (not optional) so consumers can split cloud vs self-host
 * cohorts without ambiguity between "false" and "unset".
 */
function isCloudDeployment(): boolean {
  const raw = process.env.SWARM_CLOUD;
  return raw === "true" || raw === "1";
}

/** Fire-and-forget telemetry event. Never throws, never blocks. */
export function track(options: TrackOptions): void {
  if (!isEnabled() || !installationId) return;
  try {
    const payload = {
      product: PRODUCT,
      event: options.event,
      occurred_at: new Date().toISOString(),
      source,
      actor_mode: "anonymous" as const,
      actor_anonymous_id: installationId,
      properties: {
        ...(options.properties ?? {}),
        // Cloud-cohort signal derived from MCP_BASE_URL at init time.
        // Placed at the top level of `properties_json` so ClickHouse can
        // GROUP BY without descending into nested objects. Spread LAST so
        // caller-supplied keys can never spoof the cohort classification.
        // The hostname is intentionally NOT included — telemetry must stay
        // anonymous, and the boolean is sufficient to split cloud vs self-host.
        is_cloud: cachedIsCloud,
      },
      metadata: {
        transport: "https",
        schema_version: 1,
        environment: process.env.NODE_ENV ?? "production",
        is_cloud: isCloudDeployment(),
        ...getOrgIdentity(),
        ...options.metadata,
      },
    };
    fetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    // Never throw
  }
}

/**
 * Test-only: reset the module-scoped state so tests can re-init cleanly.
 * Do not call from production code.
 */
export function _resetTelemetryStateForTests(): void {
  installationId = null;
  source = "unknown";
  cachedIsCloud = false;
}

/** Test-only: read the resolved install ID. */
export function _getInstallationIdForTests(): string | null {
  return installationId;
}

export const telemetry = {
  taskEvent(
    event: string,
    props: {
      taskId: string;
      source?: string;
      tags?: string[];
      durationMs?: number;
      hasParent?: boolean;
      agentId?: string;
      priority?: number;
      [k: string]: unknown;
    },
  ): void {
    track({ event: `task.${event}`, properties: props });
  },

  server(event: string, props?: Record<string, unknown>): void {
    track({ event: `server.${event}`, properties: props ?? {} });
  },

  session(event: string, props: { agentId: string; taskId?: string; [k: string]: unknown }): void {
    track({ event: `session.${event}`, properties: props });
  },
};
