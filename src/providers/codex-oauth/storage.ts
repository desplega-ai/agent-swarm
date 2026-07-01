/**
 * Config store persistence for Codex OAuth credentials.
 *
 * Stores/retrieves credentials via the swarm API config store at global scope.
 * The entrypoint fetches them at boot and writes ~/.codex/auth.json.
 *
 * Multi-slot support: credentials are keyed as `codex_oauth_0`, `codex_oauth_1`,
 * etc. The legacy `codex_oauth` key is treated as slot 0 (read-only fallback)
 * until the 071 migration renames it.
 */

import { refreshAccessToken } from "./flow.js";
import type { CodexOAuthCredentials } from "./types.js";

/** Legacy single-credential key — kept for backwards-compat fallback reads. */
const CODEX_OAUTH_KEY_LEGACY = "codex_oauth";

/**
 * How long a slot's refresh lock stays valid before another caller may steal
 * it — bounds the blast radius of a caller that acquires the lock and then
 * dies mid-refresh (crash recovery), matching `REFRESH_LOCK_TTL_MS` in
 * `src/oauth/ensure-token.ts`.
 */
const REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;
/** Max time to wait for another caller's in-flight refresh before giving up. */
const REFRESH_LOCK_WAIT_MS = 30 * 1000;
const REFRESH_LOCK_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the cross-process refresh lock for a Codex OAuth slot via the API
 * server's `oauth_refresh_locks` table (migration 077). Worker-side code
 * can't reach that table directly (no `bun:sqlite`/`be/db` imports), so this
 * goes over HTTP — same table the tracker-OAuth path
 * (`src/oauth/ensure-token.ts`) locks directly since it runs API-side.
 *
 * Returns the lock's `owner` token on success, or `null` if another caller
 * currently holds it.
 */
async function acquireCodexRefreshLock(
  apiUrl: string,
  apiKey: string,
  slot: number,
): Promise<string | null> {
  const key = codexOAuthKeyForSlot(slot);
  const res = await fetch(`${apiUrl}/api/oauth/refresh-locks/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ttlMs: REFRESH_LOCK_TTL_MS }),
  });

  if (res.status === 409) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to acquire codex-oauth refresh lock (slot ${slot}): HTTP ${res.status} ${text}`,
    );
  }

  const data = (await res.json()) as { owner: string };
  return data.owner;
}

/** Release a lock acquired via {@link acquireCodexRefreshLock}. Best-effort — the TTL reclaims it either way. */
async function releaseCodexRefreshLock(
  apiUrl: string,
  apiKey: string,
  slot: number,
  owner: string,
): Promise<void> {
  const key = codexOAuthKeyForSlot(slot);
  try {
    await fetch(`${apiUrl}/api/oauth/refresh-locks/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ owner }),
    });
  } catch (err) {
    console.error(
      `[codex-oauth] Failed to release refresh lock for slot ${slot} (non-fatal):`,
      err,
    );
  }
}

/** Derive the swarm_config key for a given slot index. */
export function codexOAuthKeyForSlot(slot: number): string {
  return `codex_oauth_${slot}`;
}

/**
 * Load all stored Codex OAuth credential slots from the config store.
 * Returns slots sorted by slot index (ascending).
 */
export async function loadAllCodexOAuthSlots(
  apiUrl: string,
  apiKey: string,
): Promise<Array<{ slot: number; creds: CodexOAuthCredentials }>> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/config/resolved?includeSecrets=true`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  const data = (await res.json()) as { configs: Array<{ key: string; value: string }> };
  const slotPattern = /^codex_oauth_(\d+)$/;
  const results: Array<{ slot: number; creds: CodexOAuthCredentials }> = [];

  for (const entry of data.configs ?? []) {
    const match = slotPattern.exec(entry.key);
    if (!match || !entry.value) continue;
    const slot = Number(match[1]);
    try {
      results.push({ slot, creds: JSON.parse(entry.value) as CodexOAuthCredentials });
    } catch {
      // skip entries with unparseable values
    }
  }

  return results.sort((a, b) => a.slot - b.slot);
}

export async function storeCodexOAuth(
  apiUrl: string,
  apiKey: string,
  creds: CodexOAuthCredentials,
  slot = 0,
): Promise<void> {
  const key = codexOAuthKeyForSlot(slot);
  const res = await fetch(`${apiUrl}/api/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      scope: "global",
      key,
      value: JSON.stringify(creds),
      isSecret: true,
      description: `Codex ChatGPT OAuth credentials slot ${slot} (stored by codex-login)`,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to store ${key} config: HTTP ${res.status} ${text}`);
  }
}

export async function loadCodexOAuth(
  apiUrl: string,
  apiKey: string,
  slot = 0,
): Promise<CodexOAuthCredentials | null> {
  const slotKey = codexOAuthKeyForSlot(slot);

  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/config/resolved?includeSecrets=true`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return null;
  }

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as { configs: Array<{ key: string; value: string }> };

  // Try the slot-keyed entry first.
  let entry = data.configs?.find((c) => c.key === slotKey);

  // Backwards-compat: if slot 0 requested and no slot key found, check legacy key.
  // Do NOT auto-migrate — the 071 migration handles that.
  if (!entry && slot === 0) {
    entry = data.configs?.find((c) => c.key === CODEX_OAUTH_KEY_LEGACY);
  }

  if (!entry?.value) return null;

  try {
    return JSON.parse(entry.value) as CodexOAuthCredentials;
  } catch {
    console.error("[codex-oauth] Failed to parse codex_oauth config value");
    return null;
  }
}

export async function deleteCodexOAuth(apiUrl: string, apiKey: string, slot = 0): Promise<void> {
  const key = codexOAuthKeyForSlot(slot);

  const res = await fetch(`${apiUrl}/api/config/resolved?includeSecrets=true`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) return;

  const data = (await res.json()) as { configs: Array<{ id: string; key: string }> };
  const entry = data.configs?.find((c) => c.key === key);
  if (!entry) return;

  await fetch(`${apiUrl}/api/config/${entry.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

/**
 * Best-effort persistence of refreshed OAuth credentials back to the config
 * store. Wraps {@link storeCodexOAuth} with a try/catch + `console.error` —
 * a write failure MUST NOT block the current caller from using the refreshed
 * `apiKey`. Called from `src/utils/internal-ai/credentials.ts` after token
 * rotation so the new refresh token isn't lost in-memory.
 */
export async function persistCodexOAuth(
  apiUrl: string,
  apiKey: string,
  creds: CodexOAuthCredentials,
  slot = 0,
): Promise<void> {
  try {
    await storeCodexOAuth(apiUrl, apiKey, creds, slot);
  } catch (err) {
    console.error("[codex-oauth] persistCodexOAuth failed (non-fatal):", err);
  }
}

/**
 * Load the slot's credentials and refresh them if the access token has
 * expired.
 *
 * Codex refresh tokens are single-use — OpenAI rotates the refresh token on
 * every exchange and revokes the whole token family (on a delay) if a
 * stale/already-rotated refresh token is ever replayed. Since a pool slot is
 * shared across concurrently-running tasks (each a separate worker process),
 * two callers racing this function with the same expired `creds.refresh`
 * would both exchange it — the loser replays a token OpenAI already
 * considers rotated, which eventually revokes the slot. Guard the
 * refresh-and-persist critical section with the same cross-process lock the
 * tracker-OAuth path uses (`src/oauth/ensure-token.ts`), re-reading the
 * stored credentials after acquiring the lock so a caller that lost the race
 * picks up the winner's freshly-rotated tokens instead of re-exchanging.
 */
export async function getValidCodexOAuth(
  apiUrl: string,
  apiKey: string,
  slot = 0,
): Promise<CodexOAuthCredentials | null> {
  let creds = await loadCodexOAuth(apiUrl, apiKey, slot);
  if (!creds) return null;
  if (Date.now() < creds.expires) return creds;

  const waitStartedAt = Date.now();
  for (;;) {
    // Re-read before attempting the lock — another caller may have already
    // refreshed since our last read, above or on a prior loop iteration.
    creds = await loadCodexOAuth(apiUrl, apiKey, slot);
    if (!creds) return null;
    if (Date.now() < creds.expires) return creds;

    const owner = await acquireCodexRefreshLock(apiUrl, apiKey, slot);
    if (!owner) {
      if (Date.now() - waitStartedAt > REFRESH_LOCK_WAIT_MS) {
        console.error(`[codex-oauth] Timed out waiting for slot ${slot} refresh lock`);
        return null;
      }
      await sleep(REFRESH_LOCK_POLL_MS);
      continue;
    }

    try {
      // Re-read again now that we hold the lock — another caller may have
      // rotated the refresh token between our last read and lock acquisition.
      const lockedCreds = await loadCodexOAuth(apiUrl, apiKey, slot);
      if (!lockedCreds) return null;
      if (Date.now() < lockedCreds.expires) return lockedCreds;

      console.log("[codex-oauth] Token expired, refreshing...");
      const result = await refreshAccessToken(lockedCreds.refresh);
      if (result.type !== "success") {
        console.error("[codex-oauth] Token refresh failed");
        return null;
      }

      const refreshed: CodexOAuthCredentials = {
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
        accountId: lockedCreds.accountId,
      };

      // A persist failure here MUST be fatal to this refresh: returning the
      // in-memory `refreshed` credentials without durably storing them means
      // the next caller reads the now-stale `lockedCreds.refresh` and
      // replays it, triggering exactly the family revocation this lock
      // exists to prevent. Let the error propagate instead of swallowing it.
      try {
        await storeCodexOAuth(apiUrl, apiKey, refreshed, slot);
      } catch (persistErr) {
        // `lockedCreds.refresh` is already single-use/rotated with OpenAI —
        // it can never be exchanged again. If we can't durably store the new
        // `refreshed` token, quarantine the slot (delete it from the config
        // store) so the next caller's `loadCodexOAuth` finds nothing and
        // returns null instead of reading back and replaying the
        // now-consumed old refresh token. Best-effort: a delete failure here
        // leaves the corrupted state, but we still surface the original
        // persist error so this call treats the slot as unusable.
        await deleteCodexOAuth(apiUrl, apiKey, slot).catch((deleteErr) => {
          console.error(
            `[codex-oauth] Failed to quarantine slot ${slot} after persist failure (non-fatal):`,
            deleteErr,
          );
        });
        throw persistErr;
      }

      return refreshed;
    } finally {
      await releaseCodexRefreshLock(apiUrl, apiKey, slot, owner);
    }
  }
}
