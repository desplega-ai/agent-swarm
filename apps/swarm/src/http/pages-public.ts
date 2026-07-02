/**
 * Public-facing page routes — `/p/:id` and `/p/:id.json`.
 *
 * Distinct from `src/http/pages.ts` (bearer-authed REST) — these are the
 * surfaces an end-user's browser actually hits. Both routes are declared
 * with `auth: { apiKey: false }` so the global bearer gate skips them.
 *
 * Scope of THIS module (step-3):
 *   - `auth_mode === 'public'`: ungated. HTML responses inline-inject the
 *     `BROWSER_SDK_JS` constant from `src/artifact-sdk/browser-sdk.ts` (reused
 *     verbatim — no token-injection hook on the client). JSON responses
 *     302-redirect to the SPA `/pages/:id` route (the JSON renderer lives
 *     in the SPA, not the API — step-6/7).
 *   - `auth_mode === 'authed'`: returns 401. step-4 narrows this to also
 *     accept a valid `page_session` cookie.
 *   - `auth_mode === 'password'`: returns 401. step-5 narrows this to also
 *     accept `?key=` query param + HTTP Basic.
 *
 * No request/response body is ever scrubbed in the served stream — page
 * bodies are agent-authored content and pass through verbatim. Logging
 * paths (errors only) DO scrub via `scrubSecrets`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { BROWSER_SDK_JS, SWARM_UI_JS } from "../artifact-sdk/browser-sdk";
import { getPage, incrementPageViewCount } from "../be/db";
import type { Page } from "../types";
import { getAppUrl, getConfiguredAppUrls } from "../utils/constants";
import { extractAndVerifyCookie, issuePageSessionCookie } from "../utils/page-session";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";

// ─── Route definitions (registered with auth: { apiKey: false }) ────────────

const publicPageRoute = route({
  method: "get",
  path: "/p/{id}",
  pattern: ["p", null],
  summary: "Render a page (HTML inline; JSON redirects to SPA)",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Rendered HTML page" },
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
    200: { description: "Page JSON" },
    401: { description: "Page requires an authenticated session" },
    403: { description: "Cookie does not match this page id" },
    404: { description: "Page not found" },
  },
  auth: { apiKey: false },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Inject the BROWSER_SDK script tag into an HTML body. Insert immediately
 * after `<head>` if present; otherwise prepend so partial fragments still get
 * the SDK. The script is wrapped in `<script>...</script>` with no token
 * injection (the SDK relies on server-side header injection at the
 * `/@swarm/api/*` proxy boundary).
 *
 * Also injects `<base target="_blank">` so links inside the iframed page
 * open in the parent window — avoids the user being trapped inside an
 * iframe by a misbehaving page.
 */
/**
 * Default `<head>` injection: `<base>` so links escape the iframe, Tailwind
 * Play CDN so agent pages can use utility classes out of the box, Space
 * Grotesk / Space Mono fonts to match the swarm SPA, a small reset that
 * makes pages theme-aware (dark by default) so an agent who writes zero CSS
 * still gets a presentable page, and finally the Browser SDK so
 * `window.swarmSdk` works.
 *
 * Agent-provided styles ALWAYS win — the reset uses generic selectors with
 * low specificity. Tailwind is loaded as an opt-in tool, not an enforced
 * theme.
 */
const PAGE_HEAD_DEFAULTS = `<base target="_blank">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root {
    --swarm-bg: #0b0f17;
    --swarm-card: #121826;
    --swarm-border: #22304a;
    --swarm-text: #e6eaf2;
    --swarm-muted: #7c8aa6;
    --swarm-primary: #3b82f6;
  }
  html, body { background: var(--swarm-bg); color: var(--swarm-text); }
  body {
    font-family: "Space Grotesk", system-ui, sans-serif;
    margin: 0;
    padding: 24px;
    line-height: 1.5;
  }
  code, pre, kbd, samp { font-family: "Space Mono", ui-monospace, monospace; }
  a { color: var(--swarm-primary); }
  ::selection { background: var(--swarm-primary); color: #fff; }
  @media print {
    /* Override theme variables so built-in primitives (swarm-diff, swarm-card)
       that read var(--swarm-card) / var(--swarm-border) etc. inline-styled
       backgrounds also flip to light. Without this, diff cards stay dark navy
       on print. */
    :root {
      --swarm-bg: #ffffff;
      --swarm-card: #ffffff;
      --swarm-border: #cccccc;
      --swarm-text: #000000;
      --swarm-muted: #555555;
    }
    html, body { background: white !important; color: black !important; }
    a { color: black !important; text-decoration: underline; }
    /* Hide any swarm chrome the agent (or built-in primitives) tagged with
       .no-print. Use this class on annotation badges, jump-list nav, anything
       that shouldn't appear in the PDF export. */
    .no-print { display: none !important; }
    /* Avoid page-break inside cards / diff blocks. */
    .swarm-card, swarm-diff { break-inside: avoid; }
  }
</style>`;

function injectBrowserSdk(html: string): string {
  const injection = `${PAGE_HEAD_DEFAULTS}<script>${BROWSER_SDK_JS}</script><script>${SWARM_UI_JS}</script>`;
  // Use the first occurrence of `<head>` (case-insensitive). A page that
  // doesn't have a `<head>` element (raw fragment) still gets the SDK at the
  // front of the document.
  const headOpenMatch = html.match(/<head\b[^>]*>/i);
  if (headOpenMatch) {
    const idx = headOpenMatch.index! + headOpenMatch[0].length;
    return html.slice(0, idx) + injection + html.slice(idx);
  }
  return injection + html;
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

/**
 * Build the `Content-Security-Policy` for the served HTML. Allows inline
 * scripts (required for `BROWSER_SDK_JS`) but locks down everything else to
 * `'self'`. The SPA iframes the page in step-6 with `sandbox="allow-scripts
 * allow-forms"`; the CSP is a defence-in-depth layer.
 */
function buildCsp(): string {
  // `frame-ancestors` lists every origin allowed to iframe `/p/:id`. We must
  // include the SPA origin(s). Configured app URLs may be comma-separated so
  // portless dev (`https://ui.swarm.localhost`), a Vite port (`http://localhost:5274`),
  // and a tunnel/staging origin can all coexist. Additionally, in non-production
  // we always allow `http://localhost:*` and `https://*.localhost` so swapping
  // between Vite ports / portless dev doesn't require restarting the API.
  const configured = getConfiguredAppUrls();
  const devFallbacks =
    process.env.NODE_ENV === "production"
      ? []
      : [
          "http://localhost:5274",
          "http://localhost:5175",
          "http://127.0.0.1:5274",
          "http://127.0.0.1:5175",
          "https://*.localhost",
          "http://*.localhost",
        ];
  const ancestors = Array.from(new Set([...configured, ...devFallbacks]));
  // Allow Tailwind Play CDN (`cdn.tailwindcss.com`) for scripts, Google
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
 * `page_session` cookie scoped to the same page id (the cookie is the proof
 * once the user has successfully unlocked once). For password pages, when
 * the cookie is absent/invalid the caller falls through to the `?key=` +
 * Basic-auth resolution path; for authed pages the caller surfaces 401.
 *
 * The caller passes the cookie payload (already verified by
 * `extractAndVerifyCookie`) — `null` when no cookie was sent or it failed
 * verification. Cross-page reuse (cookie for page A presented for page B)
 * surfaces as a distinct `403` so misconfigurations are debuggable, NOT a
 * generic 401.
 *
 * For password pages with no/bad cookie, returns `{ ok: false, status: 401,
 * needsPassword: true }` so the handler knows to try the password flow before
 * sending the WWW-Authenticate response.
 */
type AccessResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: string; needsPassword?: boolean };

function isAccessible(
  page: Page,
  cookiePayload: { pageId: string; exp: number } | null,
): AccessResult {
  if (page.authMode === "public") return { ok: true };

  // Cookie-first path. A cookie scoped to a DIFFERENT page id is "stale" —
  // for password mode we silently ignore it and fall through to the password
  // flow so the user can recover via `?key=` / Basic without manual cookie
  // clearing. For authed mode we surface 403 (the SPA's launch-retry path
  // handles recovery; direct browser access to authed pages is rare).
  if (cookiePayload) {
    if (cookiePayload.pageId === page.id) return { ok: true };
    if (page.authMode === "password") {
      return {
        ok: false,
        status: 401,
        reason: "password required",
        needsPassword: true,
      };
    }
    return {
      ok: false,
      status: 403,
      reason: "page-session cookie scoped to a different page id",
    };
  }

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
  if (process.env.NODE_ENV === "production") return false;
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

  const page = getPage(id);
  if (!page) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Page not found" }));
    return true;
  }

  // Pull + verify the page-session cookie ONCE — `null` covers "no cookie",
  // "tampered signature", "expired", "malformed". The access decision below
  // discriminates per-authMode.
  const cookiePayload = await extractAndVerifyCookie(req);

  const access = isAccessible(page, cookiePayload);

  // Set-Cookie that we'll attach to the eventual 200 response when the
  // password flow mints a fresh cookie inline. Empty string = no cookie to
  // attach. We thread this through the handler so the existing 200-response
  // paths below can opt-in without duplicating their branch logic.
  let inlineSetCookie = "";

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
          inlineSetCookie = await issuePageSessionCookie(page.id, {
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };
    if (inlineSetCookie) headers["Set-Cookie"] = inlineSetCookie;
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        id: page.id,
        version: 1, // edit-counter is API-internal; SPA reads via /api/pages/:id/versions
        title: page.title,
        description: page.description,
        contentType: page.contentType,
        authMode: page.authMode,
        body: page.body,
      }),
    );
    bumpViewCount(page.id);
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
      const headers: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": buildCsp(),
        "X-Content-Type-Options": "nosniff",
      };
      if (inlineSetCookie) headers["Set-Cookie"] = inlineSetCookie;
      res.writeHead(200, headers);
      res.end(printableJsonPageHtml(page));
      bumpViewCount(page.id);
      return true;
    }
    const headers: Record<string, string> = { Location: `${getAppBaseUrl()}/pages/${page.id}` };
    if (inlineSetCookie) headers["Set-Cookie"] = inlineSetCookie;
    res.writeHead(302, headers);
    res.end();
    // 302 redirects are intentionally NOT counted — they're a stop-over for
    // JSON pages, and the SPA's subsequent `/p/:id.json` fetch bumps the
    // counter via the JSON path above. Counting both would double-count.
    return true;
  }

  // text/html — inject SDK + serve. Append the self-print snippet when the
  // export button requested it.
  const html = injectBrowserSdk(page.body) + (wantsPrint ? PRINT_AUTOTRIGGER_SCRIPT : "");
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": buildCsp(),
    // Defence-in-depth: prevent MIME sniffing and clickjacking outside the SPA.
    "X-Content-Type-Options": "nosniff",
  };
  if (inlineSetCookie) headers["Set-Cookie"] = inlineSetCookie;
  res.writeHead(200, headers);
  res.end(html);
  bumpViewCount(page.id);
  return true;
}

/**
 * Best-effort view-count bump. Wrapped in try/catch so a counter write never
 * fails the response — pages are served before the bump runs, and any DB
 * error is swallowed silently. No dedup by viewer; one bump per successful
 * 200 (HTML inline or JSON metadata fetch). 302/401/403/404 responses do
 * NOT bump.
 */
function bumpViewCount(pageId: string): void {
  try {
    incrementPageViewCount(pageId);
  } catch {
    // intentional empty — analytics must never break page serving.
  }
}
