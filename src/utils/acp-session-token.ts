/**
 * HTTP helpers used by the ACP adapter to mint and revoke ephemeral session
 * tokens via the swarm API. This keeps the provider layer free of direct
 * DB imports while still allowing the adapter to exchange the full operator
 * key for a short-lived aseph_ bearer before handing credentials to the
 * ACP target process.
 */

/** Wall-clock TTL for a session token: 24 hours. Long enough for any realistic
 * ACP session; the token is actively revoked when the session finishes anyway. */
export const ACP_SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ask the swarm API to mint a short-lived `aseph_` bearer for the given
 * agent + task. Returns null (and logs a warning) if the request fails so
 * the adapter can fall back gracefully.
 */
export async function mintAcpSessionToken(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  taskId: string,
): Promise<{ tokenId: string; plaintext: string } | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/sessions/tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId, taskId, ttlMs: ACP_SESSION_TOKEN_TTL_MS }),
    });
    if (!res.ok) {
      console.warn(`\x1b[33m[acp]\x1b[0m Session token mint failed (${res.status}); using operator key`);
      return null;
    }
    const data = (await res.json()) as { tokenId: string; plaintext: string };
    return { tokenId: data.tokenId, plaintext: data.plaintext };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`\x1b[33m[acp]\x1b[0m Session token mint error: ${message}; using operator key`);
    return null;
  }
}

/**
 * Ask the swarm API to revoke a previously-minted `aseph_` token. Best-effort:
 * errors are logged but never propagated to the caller.
 */
export async function revokeAcpSessionToken(
  apiUrl: string,
  apiKey: string,
  tokenId: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl.replace(/\/+$/, "")}/api/sessions/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    // best-effort — token will expire on its own
  }
}
