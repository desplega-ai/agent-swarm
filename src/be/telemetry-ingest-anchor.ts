/**
 * Where the telemetry proxy's view of this install starts, as far as this
 * install can know it.
 *
 * The proxy anchors an install at its first received event, `min(occurred_at)`.
 * Sends are fire-and-forget, so neither the install ID's mint time nor the
 * first task says when that was. This records the earliest event the ingest
 * endpoint answered with 2xx from the API server, and whether it was the
 * install's first event ever (sent by the boot that minted the ID, dated at
 * the mint). Workers send too, so a recorded event that is not the first is
 * only an upper bound on the proxy's anchor.
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
    return {
      installationId: parsed.installationId,
      occurredAt: parsed.occurredAt,
      firstOfInstall: parsed.firstOfInstall === true,
    };
  } catch {
    return null;
  }
}

/** Whether `next` says more about the proxy's anchor than `current`. */
function improves(current: TelemetryIngestAnchor | null, next: TelemetryIngested): boolean {
  if (!current || current.installationId !== next.installationId) return true;
  if (current.firstOfInstall) return false;
  return next.firstOfInstall || Date.parse(next.occurredAt) < Date.parse(current.occurredAt);
}

/** Last value this process read or wrote; skips the DB for every later event. */
let known: TelemetryIngestAnchor | null = null;

export async function recordTelemetryIngest(ingested: TelemetryIngested): Promise<void> {
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

/** Test-only. */
export function _resetTelemetryIngestAnchorForTests(): void {
  known = null;
}
