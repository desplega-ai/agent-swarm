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

function isEnabled(): boolean {
  return process.env.ANONYMIZED_TELEMETRY !== "false";
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
      properties: options.properties ?? {},
      metadata: {
        transport: "https",
        schema_version: 1,
        environment: process.env.NODE_ENV ?? "production",
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
