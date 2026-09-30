/**
 * API-server side of the telemetry identity envelope: the parts that need the
 * DB. `src/telemetry.ts` stays DB-free so workers can import it.
 *
 * - `context.org_domain`: the email DOMAIN of the org's admin (never the email)
 * - `context.user_role`: `admin` when the user's grants include everything, else `member`
 *
 * This file must not import `./be/db` (`be/db.ts` imports the trigger module
 * that imports this one). It reads through the DB client and lazy-imports RBAC.
 */
import { getDbClient } from "./be/db/runtime";
import { setTelemetryOrgDomain } from "./telemetry";
import { emailDomain, type TelemetryUserRole } from "./telemetry-context";

const ROLE_TTL_MS = 60 * 60_000;
const ROLE_CACHE_LIMIT = 1_000;
const DOMAIN_RECOMPUTE_DEBOUNCE_MS = 2_000;

const roleCache = new Map<string, { role: TelemetryUserRole; at: number }>();
const roleLoads = new Map<string, Promise<TelemetryUserRole | undefined>>();

async function loadUserRole(userId: string): Promise<TelemetryUserRole | undefined> {
  try {
    // Lazy: be/rbac-roles imports be/db, which (transitively) imports this file.
    const { getUserGrant } = await import("./be/rbac-roles");
    const grant = await getUserGrant(userId);
    const role: TelemetryUserRole = grant.grantsAll ? "admin" : "member";
    if (roleCache.size >= ROLE_CACHE_LIMIT) {
      const oldest = roleCache.keys().next().value;
      if (oldest !== undefined) roleCache.delete(oldest);
    }
    roleCache.set(userId, { role, at: Date.now() });
    return role;
  } catch {
    return undefined;
  }
}

/** Load (or refresh) a user's role. Concurrent calls for one user share one lookup. */
export function primeUserRole(userId: string): Promise<TelemetryUserRole | undefined> {
  const hit = roleCache.get(userId);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return Promise.resolve(hit.role);
  let load = roleLoads.get(userId);
  if (!load) {
    load = loadUserRole(userId).finally(() => roleLoads.delete(userId));
    roleLoads.set(userId, load);
  }
  return load;
}

/**
 * Synchronous role lookup for `track()`. On a miss it starts a background load
 * and returns undefined, so only the first event of a user can carry a null
 * `user_role`. Emitters that are already async call `primeUserRole` first.
 */
export function cachedUserRole(userId: string): TelemetryUserRole | undefined {
  const hit = roleCache.get(userId);
  if (!hit || Date.now() - hit.at >= ROLE_TTL_MS) void primeUserRole(userId);
  return hit?.role;
}

/**
 * The email domain of the org's earliest-created active admin, falling back to
 * the earliest active user with an email. A candidate whose address has no
 * valid hostname (`admin@localhost`) is skipped. Undefined when none qualifies.
 */
export async function computeOrgDomain(): Promise<string | undefined> {
  const rows = await getDbClient().query<{ email: string }>(
    `SELECT u.email AS email
       FROM users u
      WHERE u.status = 'active' AND u.email IS NOT NULL AND TRIM(u.email) <> ''
      ORDER BY EXISTS (
                 SELECT 1 FROM principal_roles pr JOIN roles r ON r.id = pr.roleId
                  WHERE pr.principalType = 'user' AND pr.principalId = u.id AND r.grantsAll = 1
               ) DESC,
               u.createdAt ASC, u.id ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const domain = emailDomain(row.email);
    if (domain) return domain;
  }
  return undefined;
}

let persistDomain: ((domain: string | undefined) => Promise<void>) | null = null;
let lastPersistedDomain: string | undefined;
let recomputeTimer: ReturnType<typeof setTimeout> | null = null;

/** Register how to persist `telemetry_org_domain`, so workers can read it. Set by the ticker. */
export function configureOrgDomainPersistence(
  persist: ((domain: string | undefined) => Promise<void>) | null,
  alreadyStored?: string,
): void {
  persistDomain = persist;
  lastPersistedDomain = alreadyStored;
}

/** Recompute the org domain, publish it to `track()`, and persist it when it changed. */
export async function recomputeOrgDomain(): Promise<string | undefined> {
  const domain = await computeOrgDomain();
  setTelemetryOrgDomain(domain);
  if (persistDomain && domain !== lastPersistedDomain) {
    await persistDomain(domain);
    lastPersistedDomain = domain;
  }
  return domain;
}

/** Debounced `recomputeOrgDomain` for user create, update and delete. Never throws. */
export function scheduleOrgDomainRecompute(): void {
  if (!persistDomain) return; // telemetry not started (or opted out)
  if (recomputeTimer) clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null;
    recomputeOrgDomain().catch(() => {});
  }, DOMAIN_RECOMPUTE_DEBOUNCE_MS);
  recomputeTimer.unref?.();
}

/** Test-only: clear module state. */
export function _resetTelemetryIdentityForTests(): void {
  roleCache.clear();
  roleLoads.clear();
  persistDomain = null;
  lastPersistedDomain = undefined;
  if (recomputeTimer) clearTimeout(recomputeTimer);
  recomputeTimer = null;
}
