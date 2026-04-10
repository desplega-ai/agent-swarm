/**
 * Config store persistence for Codex OAuth credentials.
 *
 * Stores/retrieves credentials via the swarm API config store at global scope.
 * The entrypoint fetches them at boot and writes ~/.codex/auth.json.
 */

import { refreshAccessToken } from "./flow.js";
import type { CodexOAuthCredentials } from "./types.js";

const CODEX_OAUTH_KEY = "codex_oauth";

export async function storeCodexOAuth(
  apiUrl: string,
  apiKey: string,
  creds: CodexOAuthCredentials,
): Promise<void> {
  const res = await fetch(`${apiUrl}/api/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      scope: "global",
      key: CODEX_OAUTH_KEY,
      value: JSON.stringify(creds),
      isSecret: true,
      description: "Codex ChatGPT OAuth credentials (stored by codex-login)",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to store codex_oauth config: HTTP ${res.status} ${text}`);
  }
}

export async function loadCodexOAuth(
  apiUrl: string,
  apiKey: string,
): Promise<CodexOAuthCredentials | null> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/config/resolved?includeSecrets=true&key=${CODEX_OAUTH_KEY}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return null;
  }

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as { configs: Array<{ key: string; value: string }> };
  const entry = data.configs?.find((c) => c.key === CODEX_OAUTH_KEY);
  if (!entry?.value) return null;

  try {
    return JSON.parse(entry.value) as CodexOAuthCredentials;
  } catch {
    console.error("[codex-oauth] Failed to parse codex_oauth config value");
    return null;
  }
}

export async function deleteCodexOAuth(apiUrl: string, apiKey: string): Promise<void> {
  const res = await fetch(
    `${apiUrl}/api/config/resolved?includeSecrets=true&key=${CODEX_OAUTH_KEY}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (!res.ok) return;

  const data = (await res.json()) as { configs: Array<{ id: string; key: string }> };
  const entry = data.configs?.find((c) => c.key === CODEX_OAUTH_KEY);
  if (!entry) return;

  await fetch(`${apiUrl}/api/config/${entry.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

export async function getValidCodexOAuth(
  apiUrl: string,
  apiKey: string,
): Promise<CodexOAuthCredentials | null> {
  const creds = await loadCodexOAuth(apiUrl, apiKey);
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
    await storeCodexOAuth(apiUrl, apiKey, refreshed);
  } catch (err) {
    console.error("[codex-oauth] Failed to store refreshed credentials:", err);
  }

  return refreshed;
}
