/**
 * The daily `org.snapshot` event and the hourly telemetry ticker.
 *
 * A user count is org state, not a fact about an event, so it travels in one
 * row per install per day instead of in `context` on every event. The snapshot
 * carries counts only: no names, no emails, no user IDs.
 *
 * API server only. Workers never import this file.
 */
import type { PropsFor } from "@desplega/telemetry-contract";
import { getDbClient } from "./be/db/runtime";
import { isTelemetryReady, setTelemetryRoleResolver, telemetry } from "./telemetry";
import {
  cachedUserRole,
  configureOrgDomainPersistence,
  recomputeOrgDomain,
} from "./telemetry-identity";
import { scrubSecrets } from "./utils/secret-scrubber";

export type OrgSnapshot = PropsFor<"org.snapshot">;

export const LAST_SNAPSHOT_KEY = "telemetry_last_snapshot_at";
const ORG_DOMAIN_KEY = "telemetry_org_domain";
const FIRST_SNAPSHOT_DELAY_MS = 60_000;
const TICK_INTERVAL_MS = 60 * 60_000;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60_000;
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Identity kinds that get their own `users_linked_*` counter. Every other kind sums into `users_linked_other`. */
const NAMED_LINK_KINDS = ["slack", "github", "gitlab", "linear", "jira"] as const;

type CountRow = { n: number };

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const row = await getDbClient().get<CountRow>(sql, params as never[]);
  return Number(row?.n ?? 0);
}

/** Read-only aggregates over the user, token, identity, task and agent tables. */
export async function collectOrgSnapshot(now = Date.now()): Promise<OrgSnapshot> {
  const linked = async (kind: string) =>
    count(
      `SELECT COUNT(DISTINCT x.userId) AS n
         FROM user_external_ids x JOIN users u ON u.id = x.userId
        WHERE u.status = 'active' AND x.kind = ?`,
      [kind],
    );
  const since = new Date(now - ACTIVE_WINDOW_MS).toISOString();
  const [
    usersTotal,
    usersSuspended,
    usersAdmin,
    usersWithLogin,
    slack,
    github,
    gitlab,
    linear,
    jira,
    other,
    usersActive7d,
    agentsTotal,
  ] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`),
    count(`SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'`),
    count(
      `SELECT COUNT(DISTINCT u.id) AS n
         FROM users u
         JOIN principal_roles pr ON pr.principalType = 'user' AND pr.principalId = u.id
         JOIN roles r ON r.id = pr.roleId
        WHERE u.status = 'active' AND r.grantsAll = 1`,
    ),
    count(
      `SELECT COUNT(*) AS n
         FROM users u
        WHERE u.status = 'active'
          AND ((u.email IS NOT NULL AND TRIM(u.email) <> '')
               OR EXISTS (SELECT 1 FROM user_tokens t WHERE t.userId = u.id AND t.revokedAt IS NULL))`,
    ),
    linked("slack"),
    linked("github"),
    linked("gitlab"),
    linked("linear"),
    linked("jira"),
    count(
      `SELECT COUNT(DISTINCT x.userId) AS n
         FROM user_external_ids x JOIN users u ON u.id = x.userId
        WHERE u.status = 'active' AND x.kind NOT IN (${NAMED_LINK_KINDS.map(() => "?").join(", ")})`,
      [...NAMED_LINK_KINDS],
    ),
    count(
      `SELECT COUNT(DISTINCT requestedByUserId) AS n
         FROM agent_tasks
        WHERE requestedByUserId IS NOT NULL AND createdAt >= ?`,
      [since],
    ),
    count(`SELECT COUNT(*) AS n FROM agents`),
  ]);
  return {
    users_total: usersTotal,
    users_suspended: usersSuspended,
    users_admin: usersAdmin,
    users_with_login: usersWithLogin,
    users_linked_slack: slack,
    users_linked_github: github,
    users_linked_gitlab: gitlab,
    users_linked_linear: linear,
    users_linked_jira: jira,
    users_linked_other: other,
    users_active_7d: usersActive7d,
    agents_total: agentsTotal,
  };
}

export interface SnapshotDeps {
  getConfig: (key: string) => Promise<string | undefined> | string | undefined;
  setConfig: (key: string, value: string) => Promise<void> | void;
  now?: () => number;
}

let inFlight: Promise<boolean> | null = null;

/**
 * Send one `org.snapshot` when 24 h have passed since the last one.
 * `swarm_config.telemetry_last_snapshot_at` records the send time, so a restart
 * does not send twice in a day. Returns true when an event was sent. Never
 * throws. Sends nothing (and records nothing) when telemetry is off or not yet
 * identified, so the next tick retries.
 */
export function emitOrgSnapshotIfDue(deps: SnapshotDeps): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      if (!isTelemetryReady()) return false;
      const now = (deps.now ?? Date.now)();
      const lastRaw = await deps.getConfig(LAST_SNAPSHOT_KEY);
      const last = lastRaw ? Date.parse(lastRaw) : Number.NaN;
      if (Number.isFinite(last) && now - last < SNAPSHOT_INTERVAL_MS) return false;
      const snapshot = await collectOrgSnapshot(now);
      // Record first: a crash between the two steps loses one snapshot, where the
      // other order would send a second one on every restart loop.
      await deps.setConfig(LAST_SNAPSHOT_KEY, new Date(now).toISOString());
      telemetry.org("snapshot", snapshot);
      return true;
    } catch (err) {
      console.error(
        "[telemetry] org.snapshot failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      );
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the API server's telemetry upkeep: the role resolver for
 * `context.user_role`, the org-domain recompute (at boot, on user changes, then
 * hourly) and the daily `org.snapshot` (60 s after boot, then whenever the
 * hourly tick finds 24 h have passed). One timer, no new cadence per feature.
 * A no-op when telemetry is off.
 */
export function startTelemetryTicker(deps: SnapshotDeps): void {
  if (!isTelemetryReady()) return;
  stopTelemetryTicker();
  setTelemetryRoleResolver(cachedUserRole);

  const tick = async () => {
    try {
      await recomputeOrgDomain();
    } catch (err) {
      console.error(
        "[telemetry] org domain recompute failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      );
    }
    await emitOrgSnapshotIfDue(deps);
  };

  Promise.resolve(deps.getConfig(ORG_DOMAIN_KEY))
    .then((stored) => {
      configureOrgDomainPersistence(async (domain) => {
        // An empty value clears a stale domain, so workers stop sending it.
        await deps.setConfig(ORG_DOMAIN_KEY, domain ?? "");
      }, stored || undefined);
      return recomputeOrgDomain();
    })
    .catch(() => {});

  firstTimer = setTimeout(() => {
    firstTimer = null;
    void emitOrgSnapshotIfDue(deps);
  }, FIRST_SNAPSHOT_DELAY_MS);
  firstTimer.unref?.();
  tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  tickTimer.unref?.();
}

export function stopTelemetryTicker(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (firstTimer) clearTimeout(firstTimer);
  tickTimer = null;
  firstTimer = null;
  setTelemetryRoleResolver(null);
  configureOrgDomainPersistence(null);
}
