/**
 * Background OAuth token refresh sweep.
 *
 * The reactive path (src/oauth/ensure-token.ts) only refreshes tokens when a
 * binding is about to be USED, so rotation / inactivity-TTL refresh tokens can
 * die while a connection sits idle. This sweep walks every provider-facing
 * oauth_authorizations row on a 15-minute tick and refreshes when either:
 *
 *  (a) the access token expires within 30 minutes, or
 *  (b) the row hasn't been touched in > 7 days (keep-alive for providers that
 *      expire refresh tokens after an inactivity window, e.g. Atlassian ~90d),
 *  (c) the authorization is already in a non-terminal broken state
 *      (`refresh-failed`/`expired`) — retried each pass so transient provider
 *      outages self-heal.
 *
 * Relationship to src/oauth/keepalive.ts: that job is a 12-hour alerting
 * keepalive over keep-alive-opted-in authorizations. This sweep is the generic
 * counterpart covering every authorization registered in oauth_apps
 * (script-connection credential bindings included). Both funnel through the
 * same per-authorization locks in ensure-token, so overlap is safe.
 */
import { forceRefreshAuthorizationOrThrow } from "../oauth/ensure-token";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  type AuthorizationSweepRow,
  getAuthorizationById,
  listAuthorizationSweepRows,
} from "./db-queries/oauth";

const EXPIRY_BUFFER_MS = 30 * 60 * 1000; // (a) refresh when expiring within 30 min
const STALE_ROW_MS = 7 * 24 * 60 * 60 * 1000; // (b) keep-alive when untouched > 7 days
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_STARTUP_DELAY_MS = 60 * 1000;

export type OAuthRefreshSweepResult = {
  checked: number;
  refreshed: number;
  skipped: number;
  failed: string[];
};

function sweepRowLabel(row: AuthorizationSweepRow): string {
  return row.label && row.label !== "default" ? `${row.provider}/${row.label}` : row.provider;
}

/**
 * Run one sweep over every provider-facing OAuth authorization. Never throws —
 * per-authorization failures are persisted (`refresh-failed`, by the refresh
 * core) and collected in `failed` (logged, scrubbed) so one dead authorization
 * can't starve the rest. `revoked` rows are terminal and skipped;
 * `refresh-failed` rows stay in the sweep and retry each pass so transient
 * provider outages self-heal.
 */
export async function sweepOAuthTokenRefresh(): Promise<OAuthRefreshSweepResult> {
  let checked = 0;
  let refreshed = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const row of listAuthorizationSweepRows()) {
    checked++;

    if (row.status === "revoked" || !row.hasRefreshToken) {
      skipped++;
      continue;
    }

    const now = Date.now();
    const expiringSoon = new Date(row.expiresAt).getTime() - now < EXPIRY_BUFFER_MS;
    const stale = now - new Date(row.updatedAt).getTime() > STALE_ROW_MS;
    const isFailed = row.status === "refresh-failed" || row.status === "expired";
    if (!expiringSoon && !stale && !isFailed) {
      skipped++;
      continue;
    }

    const before = getAuthorizationById(row.authorizationId);
    try {
      await forceRefreshAuthorizationOrThrow(row.authorizationId);
      const after = getAuthorizationById(row.authorizationId);
      // forceRefreshAuthorizationOrThrow stays silent on some no-op paths (row
      // changed concurrently, config vanished mid-flight) — only count real
      // refreshes.
      const changed =
        after !== null &&
        (before === null ||
          before.accessToken !== after.accessToken ||
          before.expiresAt !== after.expiresAt ||
          before.updatedAt !== after.updatedAt);
      if (changed) {
        refreshed++;
      } else {
        skipped++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const label = sweepRowLabel(row);
      failed.push(`${label}: ${message}`);
      console.warn(scrubSecrets(`[oauth-refresh-sweep] ${label} refresh failed: ${message}`));
    }
  }

  return { checked, refreshed, skipped, failed };
}

// ─── Periodic runner ─────────────────────────────────────────────────────────

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
let inflightSweep: Promise<void> | null = null;

async function runSweepTick(trigger: "startup" | "interval"): Promise<void> {
  if (inflightSweep) return inflightSweep;
  inflightSweep = (async () => {
    try {
      const result = await sweepOAuthTokenRefresh();
      // Stay quiet on no-op ticks; one concise line when something happened.
      if (result.refreshed > 0 || result.failed.length > 0) {
        console.log(
          scrubSecrets(
            `[oauth-refresh-sweep] ${trigger}: checked=${result.checked} refreshed=${result.refreshed} skipped=${result.skipped} failed=${result.failed.length}${result.failed.length > 0 ? ` (${result.failed.join("; ")})` : ""}`,
          ),
        );
      }
    } catch (err) {
      // sweepOAuthTokenRefresh never throws by contract; belt and braces.
      console.error("[oauth-refresh-sweep] sweep tick failed:", err);
    } finally {
      inflightSweep = null;
    }
  })();
  return inflightSweep;
}

/**
 * Start the periodic OAuth refresh sweep: first run ~1 minute after boot,
 * then every 15 minutes. No-op when OAUTH_REFRESH_SWEEP_DISABLE=true or when
 * already running.
 */
export function startOAuthRefreshSweep(): void {
  if (process.env.OAUTH_REFRESH_SWEEP_DISABLE === "true") {
    console.log("[oauth-refresh-sweep] Disabled via OAUTH_REFRESH_SWEEP_DISABLE");
    return;
  }
  if (sweepInterval || startupTimeout) return;

  console.log(
    `[oauth-refresh-sweep] Starting (interval ${Math.round(SWEEP_INTERVAL_MS / 60_000)}min, first run in ${Math.round(SWEEP_STARTUP_DELAY_MS / 1000)}s)`,
  );

  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runSweepTick("startup");
  }, SWEEP_STARTUP_DELAY_MS);
  startupTimeout.unref?.();

  sweepInterval = setInterval(() => {
    void runSweepTick("interval");
  }, SWEEP_INTERVAL_MS);
  sweepInterval.unref?.();
}

/** Stop the periodic sweep and wait for any in-flight run to finish. */
export async function stopOAuthRefreshSweep(): Promise<void> {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
  if (inflightSweep) await inflightSweep;
}
