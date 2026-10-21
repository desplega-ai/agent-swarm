// The query params that carry a connection (`?apiUrl=&apiKey=`) or an
// identity hint (`?email=&name=`). `use-config` reads them once at load and
// takes them out of the URL.
//
// Relative imports only: `bun:test` runs this from the repo root.

export const CONNECTION_URL_PARAMS = ["apiUrl", "apiKey", "email", "name"] as const;

/**
 * The connection itself. No page uses these params, so they may never stay
 * in the router's URL (pages copy their search params into new links).
 * `email` and `name` are not secret, and a page can own `name` (the MCP
 * servers prefill), so only these two are dropped after load.
 */
export const CREDENTIAL_URL_PARAMS = ["apiUrl", "apiKey"] as const;

/**
 * The search string without `keys` ("" when nothing is left), or null when
 * it holds none of them.
 */
export function withoutConnectionParams(
  search: string,
  keys: readonly string[] = CONNECTION_URL_PARAMS,
): string | null {
  const params = new URLSearchParams(search);
  const found = keys.filter((key) => params.has(key));
  if (found.length === 0) return null;
  for (const key of found) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
