/**
 * Public-facing page routes — `/p/:id` and `/p/:id.json`.
 *
 * Distinct from `src/http/pages.ts` (bearer-authed REST) — these are the
 * surfaces an end-user's browser actually hits. Both routes are declared
 * with `auth: { apiKey: false }` so the global bearer gate skips them.
 *
 * Scope of THIS module (step-3):
 *   - `auth_mode === 'public'`: ungated. HTML responses inline-inject the
 *     `BROWSER_SDK_JS` constant from `src/pages/browser-sdk.ts` (reused
 *     verbatim — no token-injection hook on the client). SVG responses serve
 *     raw bytes with a restrictive CSP and no injected scripts. JSON responses
 *     302-redirect to the SPA `/pages/:id` route (the JSON renderer lives
 *     in the SPA, not the API — step-6/7).
 *   - `auth_mode === 'authed'`: returns 401. step-4 narrows this to also
 *     accept a valid `page_session_<id>` cookie.
 *   - `auth_mode === 'password'`: returns 401. step-5 narrows this to also
 *     accept `?key=` query param + HTTP Basic.
 *
 * No request/response body is ever scrubbed in the served stream — page
 * bodies are agent-authored content and pass through verbatim. Logging
 * paths (errors only) DO scrub via `scrubSecrets`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getPage, incrementPageViewCount } from "../be/db";
import { BROWSER_SDK_JS, SWARM_UI_JS } from "../pages/browser-sdk";
import { COLOR_LITERAL_THRESHOLD, countColorLiterals } from "../pages/color-literals";
import {
  feedbackKeyGuardScript,
  feedbackOverlayScripts,
  isPageFeedbackRequested,
} from "../pages/feedback-overlay";
import {
  buildPageHeadV2,
  PAGE_HEAD_V1,
  PAGE_MODE_PARAM,
  PAGE_THEME_PARAM,
} from "../pages/page-head";
import { resolvePageTheme } from "../themes/page-theme";
import { type Page, PageSchema } from "../types";
import { getAppUrl, getConfiguredAppUrls, getLocalDevAppOrigins } from "../utils/constants";
import { getNodeEnv } from "../utils/node-env";
import { extractAndVerifyCookie, pageSessionSetCookies } from "../utils/page-session";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";

// ─── Route definitions (registered with auth: { apiKey: false }) ────────────

/**
 * Wire shape sent by the `/p/{id}.json` 200 response — a subset of `Page`
 * fields plus a hardcoded `version: 1` (edit-counter is API-internal; the SPA
 * reads real version numbers via `/api/pages/:id/versions`, NOT this field).
 */
const PublicPageJsonSchema = PageSchema.pick({
  id: true,
  title: true,
  description: true,
  contentType: true,
  authMode: true,
  body: true,
}).extend({
  version: z.literal(1),
});

const publicPageRoute = route({
  method: "get",
  path: "/p/{id}",
  pattern: ["p", null],
  summary: "Render a page (HTML/SVG inline; JSON redirects to SPA)",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  responses: {
    200: {
      description: "Rendered HTML page or raw SVG image",
      unstructured:
        "Serves raw image/svg+xml bytes, the page's agent-authored HTML body (SDK-injected) or, for ?print=1 on a JSON-content page, a standalone printable HTML document — not a JSON shape",
    },
    302: { description: "Redirect to SPA for JSON content" },
    401: { description: "Page requires an authenticated session" },
    403: { description: "Cookie does not match this page id" },
    404: { description: "Page not found" },
  },
  auth: { apiKey: false },
});

const publicPageJsonRoute = route({
  method: "get",
  path: "/p/{id}.json",
  pattern: ["p", null],
  summary: "Page metadata + body as JSON (used by SPA renderer)",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Page JSON", schema: PublicPageJsonSchema },
    401: { description: "Page requires an authenticated session" },
    403: { description: "Cookie does not match this page id" },
    404: { description: "Page not found" },
  },
  auth: { apiKey: false },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * The `<head>` defaults for a page's design version (`src/pages/page-head.ts`).
 * Version 1 is the frozen original head and ignores the viewer params. Version
 * 2 resolves the theme: the page `theme`, else the viewer's `__swarm-theme`
 * preset, else Hive, plus the page `themeTokens` on top. It is dark only for
 * `__swarm-mode=dark`, and a `?print=1` export is always light. A body with
 * `COLOR_LITERAL_THRESHOLD` or more hardcoded colors also stays light: its
 * hardcoded light surfaces would get the dark-mode text color.
 */
function pageHead(page: Page, queryParams: URLSearchParams, wantsPrint: boolean): string {
  if (page.designVersion === 1) return PAGE_HEAD_V1;
  const theme = resolvePageTheme({
    pageTheme: page.theme,
    viewerTheme: queryParams.get(PAGE_THEME_PARAM),
    overrides: page.themeTokens,
  });
  const dark =
    !wantsPrint &&
    queryParams.get(PAGE_MODE_PARAM) === "dark" &&
    countColorLiterals(page.body) < COLOR_LITERAL_THRESHOLD;
  return buildPageHeadV2({ theme, mode: dark ? "dark" : "light" });
}

/** A doctype at the start of a body (`\s` also matches a BOM). */
const LEADING_DOCTYPE_RE = /^\s*<!doctype\b[^>]*>/i;
/** The `<html ...>` start tag right after a leading doctype. */
const LEADING_HTML_TAG_RE = /^\s*<!doctype\b[^>]*>\s*<html\b[^>]*>/i;

/**
 * Inject the head defaults and the BROWSER_SDK script tag into an HTML body,
 * right after the first `<head ...>` tag. The script is wrapped in
 * `<script>...</script>` with no token injection (the SDK relies on
 * server-side header injection at the `/@swarm/api/*` proxy boundary).
 *
 * A body without `<head>` (a raw fragment) still gets the SDK:
 * - Design version 1 prepends it, as it always did.
 * - Design version 2 (`standardsMode`) keeps the browser in standards mode,
 *   because its defaults are written for it. It prepends `<!doctype html>`
 *   when the body has no doctype, then injects after `<html ...>`, else after
 *   the doctype. Content before the doctype puts the page in quirks mode.
 *
 * Both head versions start with `<base target="_blank">`, so links inside the
 * iframed page open in a new tab: a misbehaving page cannot trap the user
 * inside the iframe.
 */
function injectBrowserSdk(
  html: string,
  { head, headFirst, standardsMode }: { head: string; headFirst: string; standardsMode: boolean },
): string {
  const injection = `${headFirst}${head}<script>${BROWSER_SDK_JS}</script><script>${SWARM_UI_JS}</script>`;
  const doc = standardsMode && !LEADING_DOCTYPE_RE.test(html) ? `<!doctype html>${html}` : html;
  // The first `<head>` (case-insensitive) wins.
  const leading = standardsMode
    ? (LEADING_HTML_TAG_RE.exec(doc) ?? LEADING_DOCTYPE_RE.exec(doc))
    : null;
  const idx = headTagEnd(doc) ?? (leading ? leading.index + leading[0].length : null);
  if (idx === null) return injection + doc;
  return doc.slice(0, idx) + injection + doc.slice(idx);
}

/**
 * End offset of the first `<head ...>` start tag, or null. It finds the same
 * tag as `/<head\b[^>]*>/i` in linear time. That regex rescans the rest of the
 * body for every `<head` that has no `>` after it, so a planted body could
 * block the API on each view.
 */
function headTagEnd(doc: string): number | null {
  const start = doc.search(/<head\b/i);
  if (start === -1) return null;
  const close = doc.indexOf(">", start);
  return close === -1 ? null : close + 1;
}

/**
 * Self-print snippet appended to the served document when the export button
 * opens `/p/:id?print=1`. The page prints ITSELF in the user's own browser —
 * no server-side headless browser. We wait for `load` + webfonts + a short
 * tick so the Tailwind Play CDN JIT pass and font swap settle before the
 * print dialog opens, otherwise the PDF can capture an unstyled flash.
 */
const PRINT_AUTOTRIGGER_SCRIPT = `<script>
  (function () {
    function print() { setTimeout(function () { window.print(); }, 400); }
    window.addEventListener("load", function () {
      var fonts = document.fonts;
      if (fonts && fonts.ready && typeof fonts.ready.then === "function") {
        fonts.ready.then(print, print);
      } else {
        print();
      }
    });
  })();
</script>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * Standalone, self-contained HTML for printing a JSON page. JSON pages have no
 * agent-authored HTML body (the SPA renders the tree), so `/p/:id` normally
 * 302s to the SPA. For `?print=1` we serve this minimal light-themed document
 * — pretty-printed JSON in a wrapping `<pre>` — and let the browser print it.
 */
function printableJsonPageHtml(page: Page): string {
  let body = page.body;
  try {
    body = JSON.stringify(JSON.parse(page.body), null, 2);
  } catch {
    // Preserve the original body when the stored payload is not valid JSON.
  }
  const description = page.description
    ? `<p class="description">${escapeHtml(page.description)}</p>`
    : "";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(page.title)}</title>
    <style>
      body {
        color: #111827;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.5;
        margin: 0;
        padding: 24px;
      }
      h1 {
        font-size: 24px;
        line-height: 1.2;
        margin: 0 0 8px;
      }
      .description {
        color: #4b5563;
        margin: 0 0 20px;
      }
      pre {
        background: #f8fafc;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        color: #111827;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        line-height: 1.45;
        margin: 0;
        overflow-wrap: anywhere;
        padding: 16px;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(page.title)}</h1>
    ${description}
    <pre>${escapeHtml(body)}</pre>
    ${PRINT_AUTOTRIGGER_SCRIPT}
  </body>
</html>`;
}

/**
 * Trim `.json` off the last path segment, returning the bare id. Returns
 * `null` if the segment doesn't end in `.json` (caller should fall through
 * to the plain `/p/:id` matcher).
 */
function stripJsonSuffix(idSegment: string): string | null {
  return idSegment.endsWith(".json") ? idSegment.slice(0, -".json".length) : null;
}

/**
 * Compute the SPA base URL. Public JSON pages historically redirect to the
 * local dashboard when no app URL is configured; keep that route-local
 * fallback while still delegating `APP_URL`/`DASHBOARD_URL` resolution to the
 * shared helper.
 */
const LOCAL_PAGE_APP_URL = "http://localhost:5274";

function getAppBaseUrl(): string {
  return getAppUrl(LOCAL_PAGE_APP_URL);
}

// CSP host-source without a path: optional http(s) scheme, a host that may
// start with a `*.` wildcard label, and an optional port (digits or `*`).
// Bare `*`, keywords (`'none'`, `'self'`) and anything carrying `;` or a path
// are rejected so a bad env value cannot widen or break the policy.
const FRAME_ANCESTOR_SOURCE_RE =
  /^(?:https?:\/\/)?(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::(?:\d{1,5}|\*))?$/i;

let cachedFrameAncestors: { raw: string; origins: string[] } | null = null;

/**
 * Parse `PAGES_FRAME_ANCESTORS`: extra origins allowed to iframe PUBLIC pages
 * (for example a marketing site embedding a chart). Comma or space separated.
 * Invalid entries are dropped with one warning per distinct env value; the
 * parse is cached on the raw string so a config reload picks up changes
 * without re-warning on every request.
 */
export function getPageFrameAncestors(): string[] {
  const raw = process.env.PAGES_FRAME_ANCESTORS ?? "";
  if (cachedFrameAncestors?.raw === raw) return cachedFrameAncestors.origins;
  const origins: string[] = [];
  for (const entry of raw.split(/[\s,]+/)) {
    const value = entry.replace(/\/+$/, "");
    if (!value) continue;
    if (FRAME_ANCESTOR_SOURCE_RE.test(value)) origins.push(value);
    else console.warn(`[pages] ignoring invalid PAGES_FRAME_ANCESTORS entry: ${entry}`);
  }
  cachedFrameAncestors = { raw, origins };
  return origins;
}

/**
 * Build the `Content-Security-Policy` for the served HTML. Allows inline
 * scripts (required for `BROWSER_SDK_JS`) but locks down everything else to
 * `'self'`. The SPA iframes the page in step-6 with `sandbox="allow-scripts
 * allow-forms"`; the CSP is a defence-in-depth layer. `PAGES_FRAME_ANCESTORS`
 * applies only to public pages: authed and password pages stay embeddable by
 * the app origins alone.
 */
function buildCsp(page: Page): string {
  // `frame-ancestors` lists every origin allowed to iframe `/p/:id`. We must
  // include the SPA origin(s). Configured app URLs may be comma-separated so
  // portless dev (`https://ui.swarm.localhost`), a Vite port (`http://localhost:5274`),
  // and a tunnel/staging origin can all coexist. Under an explicit
  // development/test NODE_ENV we also allow the local Vite ports and
  // `*.localhost` so swapping between them doesn't require restarting the API.
  // Unset NODE_ENV (every deployed image) gets no localhost ancestors.
  const configured = getConfiguredAppUrls();
  const devFallbacks = getLocalDevAppOrigins();
  const embedders = page.authMode === "public" ? getPageFrameAncestors() : [];
  const ancestors = Array.from(new Set([...configured, ...devFallbacks, ...embedders]));
  // Allow Tailwind Play CDN (`cdn.tailwindcss.com`, design version 1; the
  // pinned v4 build of design version 2 comes from jsdelivr) for scripts, Google
  // Fonts (`fonts.googleapis.com` stylesheets + `fonts.gstatic.com` font
  // files) for the swarm default typography, and same-origin /@swarm/api/*
  // for the Browser SDK. Inline scripts/styles remain allowed so
  // agent-emitted styles work. `cdn.jsdelivr.net` + `unpkg.com` are the two
  // dominant npm-package CDNs (Chart.js, ApexCharts, D3, htmx, Alpine, …) so
  // pages that need a viz library can `<script src="…">` instead of inlining
  // a multi-hundred-KB bundle.
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "media-src 'self' data: https: blob:",
    "connect-src 'self'",
    `frame-ancestors 'self' ${ancestors.join(" ")}`.trim(),
  ].join("; ");
}

/**
 * Decide whether a page is reachable based on cookie alone. Public pages are
 * always reachable; authed AND password pages can ALSO pass via a valid
 * `page_session_<id>` cookie (or the legacy `page_session`) whose signed
 * payload names this page (the cookie is the proof once the user has
 * successfully unlocked once). For password pages, when the cookie is
 * absent/invalid the caller falls through to the `?key=` + Basic-auth
 * resolution path; for authed pages the caller surfaces 401.
 *
 * The caller passes the cookie payload (already verified by
 * `extractAndVerifyCookie`, which ignores sessions for other pages) — `null`
 * when no session for this page was sent or it failed verification.
 *
 * For password pages with no/bad cookie, returns `{ ok: false, status: 401,
 * needsPassword: true }` so the handler knows to try the password flow before
 * sending the WWW-Authenticate response.
 */
type AccessResult =
  | { ok: true }
  | { ok: false; status: 401; reason: string; needsPassword?: boolean };

function isAccessible(
  page: Page,
  cookiePayload: { pageId: string; exp: number } | null,
): AccessResult {
  if (page.authMode === "public") return { ok: true };

  // Cookie-first path. Sessions for other pages never reach here, so an open
  // tab of page A no longer fails once page B is launched in the same browser.
  if (cookiePayload?.pageId === page.id) return { ok: true };

  if (page.authMode === "authed") {
    return {
      ok: false,
      status: 401,
      reason: "authed mode requires page-session cookie; POST /api/pages/:id/launch first",
    };
  }
  // password mode, no cookie yet — caller will try ?key= / Basic.
  return {
    ok: false,
    status: 401,
    reason: "password required",
    needsPassword: true,
  };
}

/**
 * Extract a password candidate from the request. Order of precedence:
 *   1. `?key=` query param (if present, returns it verbatim — empty string is
 *      still "present", caller decides what to do with it).
 *   2. `Authorization: Basic <base64(user:pass)>` header — decodes the base64
 *      blob, splits on the FIRST `:`, and returns the part AFTER the colon
 *      (the username is ignored — Basic auth has no notion of "username
 *      doesn't matter" so we treat anything as the username).
 *
 * Returns `null` when neither input is present, or when the Basic header is
 * malformed (bad base64, no colon, etc.). NEVER throws — malformed Basic
 * collapses to "no candidate" so the caller falls through to the 401 path.
 */
function extractPasswordCandidate(
  req: IncomingMessage,
  queryParams: URLSearchParams,
): string | null {
  const fromQuery = queryParams.get("key");
  if (fromQuery !== null) return fromQuery;

  const rawAuth = req.headers.authorization;
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  // Format: `Basic <base64>`. Match case-insensitively per RFC 7617.
  const m = /^Basic\s+(.+)$/i.exec(auth.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!, "base64").toString("utf-8");
  } catch {
    return null;
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return null;
  return decoded.slice(colonIdx + 1);
}

/**
 * Detect whether the originating request is from a "dev" / localhost context,
 * mirroring the same logic used by the bearer-launch endpoint in
 * `src/http/pages.ts`. Used to decide whether to issue cookies with
 * `SameSite=Lax` (dev) vs `SameSite=None; Secure` (prod).
 */
function isLocalhostRequest(req: IncomingMessage): boolean {
  if (getNodeEnv() === "production") return false;
  // Only emit `SameSite=Lax` (no Secure) when the request comes from the
  // SAME http://localhost origin as the API — Lax cookies don't travel on
  // cross-site fetches, so portless `*.localhost` setups (SPA on https
  // talking to the API on http) must use `SameSite=None; Secure`. Chrome
  // treats localhost as a secure origin so Secure is honored on HTTP.
  const origin = (req.headers.origin as string | undefined) ?? "";
  if (origin === "") {
    const rawHost = req.headers.host;
    const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
    if (!host) return true; // best-effort dev default
    return host.startsWith("localhost") || host.startsWith("127.0.0.1");
  }
  return origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePagesPublic(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // Both routes share the same `["p", null]` pattern; we discriminate by
  // suffix on the second segment. The route() registrations exist mainly so
  // isPublicRoute() lets these through the bearer gate — actual dispatch is
  // handled here.
  if (pathSegments.length !== 2 || pathSegments[0] !== "p") return false;
  if (req.method !== "GET") return false;

  const second = pathSegments[1]!;
  const jsonStripped = stripJsonSuffix(second);
  const isJsonRoute = jsonStripped !== null;
  const id = jsonStripped ?? second;

  // Touch parse() to (a) honour Zod validation on the id segment and (b)
  // keep the OpenAPI machinery happy. Mismatched segment counts have
  // already been handled above.
  if (isJsonRoute) {
    // Re-shim pathSegments so the route parser sees `[p, <id>]` not `[p, <id>.json]`.
    const reshim = ["p", id];
    const parsed = await publicPageJsonRoute.parse(req, res, reshim, queryParams);
    if (!parsed) return true;
  } else {
    const parsed = await publicPageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
  }

  const page = await getPage(id);
  if (!page) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Page not found" }));
    return true;
  }

  // Pull + verify the page-session cookie ONCE — `null` covers "no cookie",
  // "tampered signature", "expired", "malformed". The access decision below
  // discriminates per-authMode.
  const cookiePayload = await extractAndVerifyCookie(req, page.id);

  const access = isAccessible(page, cookiePayload);

  // Set-Cookie that we'll attach to the eventual 200 response when the
  // password flow mints a fresh cookie inline. Empty string = no cookie to
  // attach. We thread this through the handler so the existing 200-response
  // paths below can opt-in without duplicating their branch logic.
  let inlineSetCookie: string[] = [];

  if (!access.ok) {
    // Password flow: cookie missing/invalid, try `?key=` then Basic.
    if (access.needsPassword) {
      const candidate = extractPasswordCandidate(req, queryParams);
      if (candidate !== null && page.passwordHash) {
        // Bun.password.verify is constant-time (bcrypt). NEVER log the
        // candidate or hash — they may carry user-provided secrets.
        let matched = false;
        try {
          matched = await Bun.password.verify(candidate, page.passwordHash);
        } catch {
          matched = false;
        }
        if (matched) {
          inlineSetCookie = await pageSessionSetCookies(req, page.id, {
            dev: isLocalhostRequest(req),
          });
          // fall through to the regular 200 path below.
        } else {
          // Wrong password → 401 + WWW-Authenticate so the browser re-prompts.
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Basic realm="page ${page.id}"`,
          });
          res.end(JSON.stringify({ error: "incorrect password" }));
          return true;
        }
      } else {
        // No candidate at all → 401 + WWW-Authenticate so the browser shows
        // the native Basic auth dialog.
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Basic realm="page ${page.id}"`,
        });
        res.end(JSON.stringify({ error: "password required" }));
        return true;
      }
    } else {
      res.writeHead(access.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: scrubSecrets(access.reason) }));
      return true;
    }
  }

  if (isJsonRoute) {
    // `/p/:id.json` — JSON description of the page used by the SPA renderer.
    // Returns the current head state (no version history). Body included
    // verbatim. NOTE: passwordHash / agentId are NOT exposed here — these
    // are private. step-4 may revisit if needed.
    // `res.setHeader` merges with the `Content-Type: application/json` header
    // that `respond()` writes via `res.writeHead()` — Node gives the latter
    // precedence, which is the value we want here anyway.
    res.setHeader("Cache-Control", "no-store");
    if (inlineSetCookie.length > 0) res.setHeader("Set-Cookie", inlineSetCookie);
    publicPageJsonRoute.respond(res, 200, {
      id: page.id,
      version: 1, // edit-counter is API-internal; SPA reads via /api/pages/:id/versions
      title: page.title,
      description: page.description,
      contentType: page.contentType,
      authMode: page.authMode,
      body: page.body,
    });
    await bumpViewCount(page.id);
    return true;
  }

  // SVG stays byte-for-byte intact, including when ?print=1 is supplied.
  if (page.contentType === "image/svg+xml") {
    const headers: Record<string, string | string[]> = {
      "Content-Type": "image/svg+xml",
      "Cache-Control": page.authMode === "public" ? "public, max-age=1800" : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
    if (inlineSetCookie.length > 0) headers["Set-Cookie"] = inlineSetCookie;
    res.writeHead(200, headers);
    res.end(page.body);
    await bumpViewCount(page.id);
    return true;
  }

  // `?print=1` — the SPA's "Export PDF" button opens the page in a new tab
  // with this flag so the page self-prints in the user's own browser (no
  // server-side headless browser). HTML pages get the auto-print snippet
  // appended; JSON pages — which normally 302 to the SPA — are served as a
  // standalone printable document instead.
  const wantsPrint = queryParams.get("print") === "1";

  // `/p/:id` — render either HTML directly or 302→SPA for JSON.
  if (page.contentType === "application/json") {
    if (wantsPrint) {
      const headers: Record<string, string | string[]> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": buildCsp(page),
        "X-Content-Type-Options": "nosniff",
      };
      if (inlineSetCookie.length > 0) headers["Set-Cookie"] = inlineSetCookie;
      res.writeHead(200, headers);
      res.end(printableJsonPageHtml(page));
      await bumpViewCount(page.id);
      return true;
    }
    const headers: Record<string, string | string[]> = {
      Location: `${getAppBaseUrl()}/pages/${page.id}`,
    };
    if (inlineSetCookie.length > 0) headers["Set-Cookie"] = inlineSetCookie;
    res.writeHead(302, headers);
    res.end();
    // 302 redirects are intentionally NOT counted — they're a stop-over for
    // JSON pages, and the SPA's subsequent `/p/:id.json` fetch bumps the
    // counter via the JSON path above. Counting both would double-count.
    return true;
  }

  // text/html — inject SDK + serve. Append the self-print snippet when the
  // export button requested it, and the feedback overlay when
  // `?__swarm-feedback` is on (the overlay hides itself in print).
  // The feedback key guard goes first in <head> so it runs before page scripts.
  const feedback = isPageFeedbackRequested(queryParams);
  const html =
    injectBrowserSdk(page.body, {
      head: pageHead(page, queryParams, wantsPrint),
      headFirst: feedback ? feedbackKeyGuardScript() : "",
      standardsMode: page.designVersion !== 1,
    }) +
    (wantsPrint ? PRINT_AUTOTRIGGER_SCRIPT : "") +
    (feedback ? feedbackOverlayScripts(page.id) : "");
  const headers: Record<string, string | string[]> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": buildCsp(page),
    // Defence-in-depth: prevent MIME sniffing and clickjacking outside the SPA.
    "X-Content-Type-Options": "nosniff",
  };
  if (inlineSetCookie.length > 0) headers["Set-Cookie"] = inlineSetCookie;
  res.writeHead(200, headers);
  res.end(html);
  await bumpViewCount(page.id);
  return true;
}

/**
 * Best-effort view-count bump. Wrapped in try/catch so a counter write never
 * fails the response — pages are served before the bump runs, and any DB
 * error is swallowed silently. No dedup by viewer; one bump per successful
 * 200 (HTML inline or JSON metadata fetch). 302/401/403/404 responses do
 * NOT bump.
 */
async function bumpViewCount(pageId: string): Promise<void> {
  try {
    await incrementPageViewCount(pageId);
  } catch {
    // intentional empty — analytics must never break page serving.
  }
}
