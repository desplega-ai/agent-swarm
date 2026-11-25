/**
 * Turning telemetry on while the API server runs.
 *
 * `initTelemetry` returns early when telemetry is off at boot, so no install
 * ID exists and `emit` drops every event until a restart. This module keeps
 * the boot config accessors and re-runs `initTelemetry` the first time the
 * flag reads on after reading off: from the dashboard banner's "Turn on"
 * (`via: banner`) or any config reload (`via: settings`). Each off-to-on
 * transition starts the telemetry ticker and sends `telemetry.enabled` once;
 * an on-to-off transition stops the ticker.
 */
import { initTelemetry, isTelemetryEnabled, setTelemetryIngestObserver, track } from "../telemetry";
import { discardOrgActivity } from "../telemetry-activity";
import { startTelemetryTicker, stopTelemetryTicker } from "../telemetry-snapshot";
import { telemetryIngestRecorder } from "./telemetry-ingest-anchor";

type GetConfig = (key: string) => Promise<string | undefined>;
type SetConfig = (key: string, value: string) => Promise<void>;
export type TelemetryEnabledVia = "banner" | "settings" | "benchmark" | "env";

let accessors: { getConfig: GetConfig; setConfig: SetConfig } | null = null;
let lastEnabled = false;

/**
 * Boot-time `initTelemetry` for the API server. Sends `telemetry.enabled
 * { via: "env" }` when this boot minted the install ID: the first boot of an
 * install with telemetry on.
 */
export async function initApiTelemetry(getConfig: GetConfig, setConfig: SetConfig): Promise<void> {
  accessors = { getConfig, setConfig };
  // Accepted events anchor the fleet benchmark (see telemetry-ingest-anchor).
  const recordIngest = telemetryIngestRecorder();
  setTelemetryIngestObserver((ingested) => {
    recordIngest(ingested).catch(() => {});
  });
  lastEnabled = isTelemetryEnabled();
  if (!lastEnabled) return;
  let hadInstallId = true;
  try {
    hadInstallId = Boolean(await getConfig("telemetry_installation_id"));
  } catch {
    // Unknown: do not claim a first boot.
  }
  await initTelemetry("api-server", getConfig, setConfig, { generateIfMissing: true });
  if (!hadInstallId) track({ event: "telemetry.enabled", properties: { via: "env" } });
}

/**
 * Call after the telemetry flag may have changed (config reload, banner).
 * Re-initializes and sends `telemetry.enabled` on an off-to-on transition.
 * Returns whether it did.
 */
export async function syncTelemetryEnabled(via: TelemetryEnabledVia): Promise<boolean> {
  const enabled = isTelemetryEnabled();
  const wasEnabled = lastEnabled;
  lastEnabled = enabled;
  // An opt-out discards the buffered org.activity window, even with no hourly
  // tick or restart before a later opt-in.
  if (enabled !== wasEnabled) discardOrgActivity();
  // The hourly ticker (org.activity, org.snapshot, org domain) starts only when
  // telemetry is on at boot, so it follows the flag here both ways.
  if (!enabled && wasEnabled) stopTelemetryTicker();
  if (!enabled || wasEnabled || !accessors) return false;
  await initTelemetry("api-server", accessors.getConfig, accessors.setConfig, {
    generateIfMissing: true,
  });
  startTelemetryTicker(accessors);
  track({ event: "telemetry.enabled", properties: { via } });
  return true;
}

/** Test-only. */
export function _resetTelemetryEnableForTests(): void {
  accessors = null;
  lastEnabled = false;
}
