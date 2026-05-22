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

export async function getValidCodexOAuth(
  apiUrl: string,
  apiKey: string,
  slot = 0,
): Promise<CodexOAuthCredentials | null> {
  const creds = await loadCodexOAuth(apiUrl, apiKey, slot);
  if (!creds) return null;

  if (Date.now() < creds.expires) {
    return creds;
  }

  console.log("[codex-oauth] Token expired, refreshing...");
  const result = await refreshAccessToken(creds.refresh);
  if (result.type !== "success") {
    console.error("[codex-oauth] Token refresh failed");
    return null;
  }

  const accountId = creds.accountId;
  const refreshed: CodexOAuthCredentials = {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId,
  };

  try {
    await storeCodexOAuth(apiUrl, apiKey, refreshed, slot);
  } catch (err) {
    console.error("[codex-oauth] Failed to store refreshed credentials:", err);
  }

  return refreshed;
}
