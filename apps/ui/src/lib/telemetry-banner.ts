/**
 * The dashboard banner shown to admins while telemetry is off.
 *
 * It cannot report its own impressions (telemetry is off while it shows). The
 * only signals come after someone opts in: `telemetry.enabled { via: "banner" }`,
 * then `org.profile_updated { surface: "telemetry_banner" }`.
 */

/**
 * How long after a dismissal the banner comes back. `null`: never. A banner
 * that keeps returning after "Dismiss" is a dark pattern, so it stays null
 * unless a product decision changes it.
 */
export const TELEMETRY_BANNER_RESHOW_AFTER_MS: number | null = null;

/** Card key for the dismissal timestamp (namespaced per API by the storage helper). */
export const TELEMETRY_BANNER_CARD_KEY = "dashboard-telemetry-off";

/** The stored dismissal time for `storageKey`, or null. Storage that cannot be read counts as none. */
export function readTelemetryBannerDismissedAt(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function showTelemetryBanner(input: {
  /** `/status` `telemetry.enabled`; undefined while loading or on an older server. */
  telemetryEnabled: boolean | undefined;
  isAdmin: boolean;
  /** ISO time of the last dismissal, or null. */
  dismissedAt: string | null;
  reshowAfterMs?: number | null;
  nowMs?: number;
}): boolean {
  if (input.telemetryEnabled !== false || !input.isAdmin) return false;
  if (input.dismissedAt === null) return true;
  const reshowAfterMs =
    input.reshowAfterMs === undefined ? TELEMETRY_BANNER_RESHOW_AFTER_MS : input.reshowAfterMs;
  if (reshowAfterMs === null) return false;
  const dismissedMs = Date.parse(input.dismissedAt);
  // A dismissal we cannot read counts as recent.
  if (!Number.isFinite(dismissedMs)) return false;
  return (input.nowMs ?? Date.now()) - dismissedMs >= reshowAfterMs;
}
