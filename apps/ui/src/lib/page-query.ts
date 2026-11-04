// The query string a `/pages/:id` link forwards to the page body (`/p/:id`).
// Shared by the page route and the link preview panel, so both show the same
// view of a page.
//
// Relative imports only: `bun:test` runs this from the repo root.

/**
 * Query params that give a design version 2 page the viewer's theme preset
 * and color mode. The API reads them on `/p/:id` under the same constant
 * names (`src/pages/page-head.ts`). Version 1 pages ignore them.
 */
export const PAGE_THEME_PARAM = "__swarm-theme";
export const PAGE_MODE_PARAM = "__swarm-mode";

/**
 * Query params the SPA owns on `/pages/:id` and must never forward to the
 * page body: `mode` (full-screen toggle), `key` (password unlock is handled
 * by the password frame itself), the connection overrides, which would
 * otherwise hand the API key to agent-authored HTML, and the viewer theme
 * params, which only `withViewerTheme` sets (from the dashboard theme).
 */
const SPA_RESERVED_PAGE_PARAMS = new Set([
  "mode",
  "key",
  "apiUrl",
  "apiKey",
  PAGE_THEME_PARAM,
  PAGE_MODE_PARAM,
]);

/**
 * Query string forwarded from the SPA route to the page body, so a link like
 * `/pages/<id>?target=pr-1373` reaches the iframe as `/p/<id>?target=pr-1373`
 * and the page can filter or deep-link on its own params. Empty when there is
 * nothing to forward.
 */
export function pageFrameQuery(searchParams: URLSearchParams): string {
  const forwarded = new URLSearchParams();
  for (const [name, value] of searchParams) {
    if (!SPA_RESERVED_PAGE_PARAMS.has(name)) forwarded.append(name, value);
  }
  const query = forwarded.toString();
  return query ? `?${query}` : "";
}
