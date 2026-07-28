/**
 * Network egress lockdown for READ-ONLY script runs (routing dry runs).
 *
 * Gating `ctx.swarm` and stripping connection descriptors is not sufficient on
 * its own: the subprocess still has a working global `fetch`, so a handler that
 * carries a credential in its own source — or that simply posts to an
 * unauthenticated webhook — could perform a real external write while being
 * "dry run". This patch allows only the swarm API itself, which is what the SDK
 * bridge needs, and rejects everything else.
 *
 * Applied AFTER the credential-broker patch so it wraps it: the broker would
 * otherwise substitute real credentials into a request this layer then blocks,
 * which is harmless but wasteful, and ordering it this way keeps the rejection
 * the outermost behaviour.
 */
export function patchFetchForReadOnly(mcpBaseUrl: string): void {
  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(mcpBaseUrl).origin;
  } catch {
    // An unparseable base URL means we cannot establish what "the swarm API"
    // is, so allow nothing rather than falling open.
    allowedOrigin = "";
  }

  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let origin: string | null = null;
    try {
      origin = new URL(rawUrl).origin;
    } catch {
      origin = null;
    }
    if (!allowedOrigin || origin !== allowedOrigin) {
      throw new Error(
        `Network egress to ${origin ?? rawUrl} is blocked in read-only mode (routing dry-run). ` +
          "Dry runs may only reach the swarm API.",
      );
    }
    return inner(input, init);
  }) as typeof fetch;
}
