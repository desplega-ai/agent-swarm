/**
 * Where the telemetry proxy's view of this install starts, as far as this
 * install can know it.
 *
 * The proxy anchors an install at its first received event, `min(occurred_at)`.
 * Sends are fire-and-forget and workers send too, on their own clocks, so no
 * local timestamp says when that was. This records the earliest event the
 * ingest endpoint answered with 2xx from the API server: an upper bound on the
 * proxy's anchor, never the anchor itself.
 */
import type { TelemetryIngested } from "../telemetry";
import { getSwarmConfigs, upsertSwarmConfig } from "./db";
import { getDbClient } from "./db/runtime";

export const TELEMETRY_FIRST_INGEST_KEY = "telemetry_first_ingest";

export type TelemetryIngestAnchor = TelemetryIngested;

function parseAnchor(value: string | undefined): TelemetryIngestAnchor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TelemetryIngestAnchor>;
    if (
      typeof parsed.installationId !== "string" ||
      typeof parsed.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.occurredAt))
    )
      return null;
    return { installationId: parsed.installationId, occurredAt: parsed.occurredAt };
  } catch {
    return null;
  }
}

/** Whether `next` is an earlier accepted event than `current`. */
function improves(current: TelemetryIngestAnchor | null, next: TelemetryIngested): boolean {
  if (!current || current.installationId !== next.installationId) return true;
  return Date.parse(next.occurredAt) < Date.parse(current.occurredAt);
}

/**
 * Records accepted events. Keeps the last value it read or wrote, so later
 * events skip the DB; the API server makes one per telemetry init.
 */
export function telemetryIngestRecorder(): (ingested: TelemetryIngested) => Promise<void> {
  let known: TelemetryIngestAnchor | null = null;
  return async (ingested) => {
    if (!improves(known, ingested)) return;
    await getDbClient().transaction(async () => {
      const stored = parseAnchor(
        (await getSwarmConfigs({ scope: "global", key: TELEMETRY_FIRST_INGEST_KEY }))[0]?.value,
      );
      if (!improves(stored, ingested)) {
        known = stored;
        return;
      }
      await upsertSwarmConfig({
        scope: "global",
        key: TELEMETRY_FIRST_INGEST_KEY,
        value: JSON.stringify(ingested),
        description:
          "Earliest telemetry event the ingest endpoint accepted (fleet benchmark anchor).",
      });
      known = ingested;
    });
  };
}

/** The recorded anchor for the current install ID, or null when there is none. */
export async function getTelemetryIngestAnchor(): Promise<TelemetryIngestAnchor | null> {
  const [anchor, installId] = await Promise.all([
    getSwarmConfigs({ scope: "global", key: TELEMETRY_FIRST_INGEST_KEY }),
    getSwarmConfigs({ scope: "global", key: "telemetry_installation_id" }),
  ]);
  const parsed = parseAnchor(anchor[0]?.value);
  return parsed && parsed.installationId === installId[0]?.value ? parsed : null;
}
