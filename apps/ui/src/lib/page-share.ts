/**
 * Link previews for shared `/pages/:id` URLs.
 *
 * The dashboard is a static SPA, so every path serves index.html with the
 * generic dashboard card. On Vercel, `vercel.json` rewrites crawler requests
 * for `/pages/:id` to `api/page-share.ts`, which looks the page up on the
 * swarm API (`GET /p/:id/og`, public pages only) and answers with the page's
 * own title, description and an `/api/og` card (`api/og.ts`). Any miss (no API
 * configured, a private page, a slow or failing API) serves the generic card.
 * The nginx image gets the same result from the API instead: it proxies
 * crawlers to `GET /p/:id/share`, which renders with `renderShareHtml` and
 * points at the API's own card, `/p/:id/og.png`.
 *
 * Runtime-neutral on purpose: the Vercel functions import it, and so do tests.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

/** Mirrors the generic tags in index.html. */
export const GENERIC_SHARE = {
  title: "Agent Swarm Dashboard",
  description: "Monitor and manage your AI agent swarm — tasks, agents, epics, and more.",
  imagePath: "/og-image.png",
  imageAlt: "Agent Swarm dashboard",
} as const;

/** og:description for a public page that has no description of its own. */
export const PAGE_FALLBACK_DESCRIPTION = "A page shared from Agent Swarm.";

/** Page ids are UUID-like; anything else never reaches the API. */
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isPageId(value: string | null | undefined): value is string {
  return typeof value === "string" && PAGE_ID_RE.test(value);
}

/**
 * The swarm API origin the crawler path reads page metadata from:
 * `SWARM_API_URL`, else the SPA's own `VITE_API_URL`. Null when neither is a
 * valid http(s) URL, which means every page gets the generic card.
 */
export function resolveShareApiUrl(env: Record<string, string | undefined>): string | null {
  for (const raw of [env.SWARM_API_URL, env.VITE_API_URL]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
      }
    } catch {
      // Not a URL: try the next source.
    }
  }
  return null;
}

export interface PageShareInfo {
  title: string;
  description: string | null;
}

/**
 * Public share metadata for a page, or null on any miss. The API answers 404
 * for private pages, so a null never says whether the page exists.
 */
export async function fetchPageShareInfo(
  apiUrl: string,
  id: string,
  { fetchImpl = fetch, timeoutMs = 2500 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PageShareInfo | null> {
  if (!isPageId(id)) return null;
  try {
    const res = await fetchImpl(`${apiUrl}/p/${encodeURIComponent(id)}/og`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: unknown; description?: unknown };
    if (typeof data.title !== "string" || !data.title.trim()) return null;
    const description =
      typeof data.description === "string" && data.description.trim()
        ? data.description.trim()
        : null;
    return { title: data.title.trim(), description };
  } catch {
    return null;
  }
}

/** Cut at a word boundary and add an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** The card params for a title and description (the landing card's `?title=&subtitle=`). */
export function pageCardParams(title: string, description: string | null): URLSearchParams {
  const params = new URLSearchParams({ title: clip(title, 120) });
  if (description?.trim()) params.set("subtitle", clip(description, 160));
  return params;
}

/** The `/api/og` card URL for a title and description (same params as the landing card). */
export function pageCardUrl(origin: string, title: string, description: string | null): string {
  return `${origin.replace(/\/+$/, "")}/api/og?${pageCardParams(title, description)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ShareHtmlInput {
  title: string;
  description: string;
  imageUrl: string;
  imageAlt: string;
  /** The shared URL (the SPA route), used for og:url and the fallback link. */
  url: string;
}

/** A minimal document for crawlers: share tags plus a link to the page. */
export function renderShareHtml(input: ShareHtmlInput): string {
  const t = escapeHtml(input.title);
  const d = escapeHtml(input.description);
  const img = escapeHtml(input.imageUrl);
  const url = escapeHtml(input.url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Agent Swarm">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="${OG_SIZE.width}">
<meta property="og:image:height" content="${OG_SIZE.height}">
<meta property="og:image:alt" content="${escapeHtml(input.imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
</head>
<body><a href="${url}">${t}</a></body>
</html>
`;
}

/**
 * The crawler response for `/pages/:id`: the page's own card when the API
 * knows it as public, else the generic dashboard card.
 */
export async function buildPageShareHtml({
  origin,
  id,
  apiUrl,
  fetchImpl,
}: {
  origin: string;
  id: string | null;
  apiUrl: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ html: string; matched: boolean }> {
  const url = isPageId(id) ? `${origin}/pages/${id}` : `${origin}/`;
  const info = apiUrl && isPageId(id) ? await fetchPageShareInfo(apiUrl, id, { fetchImpl }) : null;
  if (!info) {
    return {
      matched: false,
      html: renderShareHtml({
        title: GENERIC_SHARE.title,
        description: GENERIC_SHARE.description,
        imageUrl: `${origin}${GENERIC_SHARE.imagePath}`,
        imageAlt: GENERIC_SHARE.imageAlt,
        url,
      }),
    };
  }
  return {
    matched: true,
    html: renderShareHtml({
      title: info.title,
      description: clip(info.description ?? PAGE_FALLBACK_DESCRIPTION, 200),
      imageUrl: pageCardUrl(origin, info.title, info.description),
      imageAlt: info.title,
      url,
    }),
  };
}

// ─── Card text (ported from agent-swarm-landing src/lib/og/shared.tsx) ──────

export interface OgCardInput {
  title: string;
  subtitle: string;
  /** Title words before the accent. */
  lead: string[];
  /** Trailing title words drawn in the brand accent. */
  accent: string[];
}

const LINK_WORDS = new Set(["with", "for", "that", "without", "into", "on", "from"]);
const SUFFIX = /\s*[|·–—-]\s*Agent Swarm\s*$/i;

/**
 * Parse `?title=&subtitle=&accent=` (`description` is accepted for
 * `subtitle`). Without `accent`, the phrase after the last linking word is
 * accented, else the last third of the title, max three words.
 */
export function parseOgParams(params: URLSearchParams): OgCardInput {
  const rawTitle = clip(params.get("title") ?? "", 160);
  const title = rawTitle.replace(SUFFIX, "").trim() || "Agent Swarm";
  const subtitle = clip(params.get("subtitle") ?? params.get("description") ?? "", 300);
  const words = title.split(/\s+/);

  let accentCount = Math.min(3, Math.max(1, Math.ceil(words.length / 3)));
  for (let i = words.length - 2; i >= Math.floor(words.length / 3); i--) {
    if (LINK_WORDS.has((words[i] ?? "").toLowerCase()) && words.length - i - 1 <= 5) {
      accentCount = words.length - i - 1;
      break;
    }
  }
  const accentParam = params.get("accent")?.trim();
  if (accentParam && title.endsWith(accentParam)) {
    accentCount = accentParam.split(/\s+/).length;
  }
  if (words.length === 1) accentCount = 1;

  return {
    title,
    subtitle,
    lead: words.slice(0, words.length - accentCount),
    accent: words.slice(words.length - accentCount),
  };
}
