import { getSwarmConfigs, upsertSwarmConfig } from "../be/db";
import { acquireOAuthRefreshLock, releaseOAuthRefreshLock } from "../be/db-queries/oauth";
import { refreshAccessToken } from "../providers/codex-oauth/flow";
import { CODEX_OAUTH_KEY_LEGACY, codexOAuthKeyForSlot } from "../providers/codex-oauth/storage";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types";

const refreshLocks = new Map<string, Promise<void>>();
const REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 30 * 1000;
const REFRESH_LOCK_POLL_MS = 250;

type HarnessOAuthProvider = "codex";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLocalRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = refreshLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  refreshLocks.set(key, next);

  await previous.catch(() => undefined);

  try {
    return await fn();
  } finally {
    release();
    if (refreshLocks.get(key) === next) {
      refreshLocks.delete(key);
    }
  }
}

function loadCodexCredentials(slot: number): CodexOAuthCredentials | null {
  const slotKey = codexOAuthKeyForSlot(slot);
  const slotEntry = getSwarmConfigs({ scope: "global", key: slotKey })[0];
  const legacyEntry =
    slot === 0 ? getSwarmConfigs({ scope: "global", key: CODEX_OAUTH_KEY_LEGACY })[0] : undefined;
  const entry = slotEntry ?? legacyEntry;
  if (!entry?.value) return null;

  try {
    return JSON.parse(entry.value) as CodexOAuthCredentials;
  } catch {
    throw new Error(`Stored ${entry.key} config is not valid Codex OAuth JSON`);
  }
}

function persistCodexCredentials(slot: number, creds: CodexOAuthCredentials): void {
  const key = codexOAuthKeyForSlot(slot);
  upsertSwarmConfig({
    scope: "global",
    key,
    value: JSON.stringify(creds),
    isSecret: true,
    description: `Codex ChatGPT OAuth credentials slot ${slot} (server-refreshed)`,
  });
}

function isFresh(expires: number, bufferMs: number): boolean {
  return expires - Date.now() > bufferMs;
}

async function ensureCodexOAuth(slot: number, bufferMs: number): Promise<CodexOAuthCredentials> {
  const lockKey = `harness:codex:${slot}`;
  const observed = loadCodexCredentials(slot);
  if (!observed) {
    throw new Error(`No Codex OAuth credentials found for slot ${slot}`);
  }
  if (isFresh(observed.expires, bufferMs)) return observed;

  return withLocalRefreshLock(lockKey, async () => {
    const waitStartedAt = Date.now();

    while (true) {
      const current = loadCodexCredentials(slot);
      if (!current) {
        throw new Error(`No Codex OAuth credentials found for slot ${slot}`);
      }
      if (isFresh(current.expires, bufferMs) || current.refresh !== observed.refresh) {
        return current;
      }

      const owner = acquireOAuthRefreshLock(lockKey, REFRESH_LOCK_TTL_MS);
      if (!owner) {
        if (Date.now() - waitStartedAt > REFRESH_LOCK_WAIT_MS) {
          throw new Error(`Timed out waiting for ${lockKey} OAuth refresh lock`);
        }
        await sleep(REFRESH_LOCK_POLL_MS);
        continue;
      }

      try {
        const locked = loadCodexCredentials(slot);
        if (!locked) {
          throw new Error(`No Codex OAuth credentials found for slot ${slot}`);
        }
        if (isFresh(locked.expires, bufferMs) || locked.refresh !== observed.refresh) {
          return locked;
        }

        const result = await refreshAccessToken(locked.refresh);
        if (result.type !== "success") {
          throw new Error(`Codex OAuth token refresh failed for slot ${slot}`);
        }

        const beforePersist = loadCodexCredentials(slot);
        if (!beforePersist) {
          throw new Error(`Codex OAuth credentials disappeared during refresh for slot ${slot}`);
        }
        if (beforePersist.refresh !== locked.refresh) {
          throw new Error(
            `Codex OAuth refresh persistence failed for slot ${slot}: stored refresh token changed during refresh`,
          );
        }

        const refreshed: CodexOAuthCredentials = {
          access: result.access,
          refresh: result.refresh,
          expires: result.expires,
          accountId: locked.accountId,
        };
        persistCodexCredentials(slot, refreshed);
        console.log(`[harness-oauth] Refreshed codex OAuth slot ${slot}`);
        return refreshed;
      } finally {
        releaseOAuthRefreshLock(lockKey, owner);
      }
    }
  });
}

export async function ensureHarnessOAuth(
  provider: HarnessOAuthProvider,
  opts: { slot?: number; bufferMs?: number } = {},
): Promise<CodexOAuthCredentials> {
  const slot = opts.slot ?? 0;
  const bufferMs = opts.bufferMs ?? 5 * 60 * 1000;
  if (provider === "codex") {
    return ensureCodexOAuth(slot, bufferMs);
  }
  throw new Error(`Unsupported harness OAuth provider: ${provider}`);
}
