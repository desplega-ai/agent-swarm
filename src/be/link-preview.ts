/**
 * Open Graph previews for links in agent replies (the dashboard's link hover
 * card). The API fetches the page once, keeps title, description, image and
 * site name, and caches the answer in memory. A failure is cached too, for a
 * shorter time, so a dead link is not fetched on every hover.
 *
 * Every hop goes through the egress guard: loopback, private and link-local
 * hosts are refused, by literal and by DNS answer, so the preview route can
 * never read the swarm's own network.
 */
import { assertUrlSafe, createGuardedFetch, EgressDeniedError } from "../utils/egress-guard";

export interface LinkPreview {
  url: string;
  ok: boolean;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

export class LinkPreviewRefusedError extends Error {}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_HTML_BYTES = 512 * 1024;
// A longer og:image URL is dropped, so a hostile page cannot fill the cache with it.
const MAX_IMAGE_URL_CHARS = 2048;
const OK_TTL_MS = 6 * 60 * 60_000;
const FAIL_TTL_MS = 10 * 60_000;
// shortcut: a per-process Map, not shared across API replicas; move to KV if previews get hot.
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: LinkPreview }>();

export function clearLinkPreviewCache(): void {
  cache.clear();
}

/** Refuses a non-http(s) URL and a loopback or private literal host. Returns the parsed URL. */
export function assertPreviewUrl(raw: string): URL {
  try {
    return assertUrlSafe(raw, { allowInsecure: true, allowPrivateHosts: false });
  } catch (error) {
    throw new LinkPreviewRefusedError(error instanceof Error ? error.message : String(error));
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X"
          ? Number.parseInt(code.slice(2), 16)
          : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function clean(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The `og:` / `twitter:` / `description` metadata and `<title>` of an HTML document. */
export function parseOpenGraph(html: string, pageUrl: string): Omit<LinkPreview, "url" | "ok"> {
  const meta = new Map<string, string>();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of tag[0].matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs.set((attr[1] ?? "").toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const rawImage = meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image");
  let image: string | null = null;
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage.trim()), pageUrl);
      const httpScheme = resolved.protocol === "https:" || resolved.protocol === "http:";
      if (httpScheme && resolved.href.length <= MAX_IMAGE_URL_CHARS) image = resolved.href;
    } catch {
      image = null;
    }
  }
  return {
    title: clean(meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag, 200),
    description: clean(
      meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"),
      400,
    ),
    image,
    siteName: clean(meta.get("og:site_name"), 80),
  };
}

/** Reads at most `max` bytes of a body as text, then cancels the rest. */
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

export interface LinkPreviewDeps {
  fetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

/**
 * The preview of `raw`. Throws `LinkPreviewRefusedError` for a URL the guard
 * refuses (bad scheme, private or loopback host, a redirect to one). Any
 * other failure (timeout, HTTP error, not HTML) returns `ok: false`.
 */
export async function getLinkPreview(
  raw: string,
  deps: LinkPreviewDeps = {},
): Promise<LinkPreview> {
  const url = assertPreviewUrl(raw);
  url.hash = "";
  const key = url.href;
  const now = deps.now ?? Date.now;
  const hit = cache.get(key);
  if (hit && now() - hit.at < (hit.value.ok ? OK_TTL_MS : FAIL_TTL_MS)) return hit.value;

  const guarded = createGuardedFetch(
    deps.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch),
    {
      policy: { allowPrivate: false, allowlist: null },
      resolve: deps.resolve,
      checkUrl: (hop) => {
        assertPreviewUrl(hop.href);
      },
      label: "Link preview refused",
    },
  );
  const empty = { title: null, description: null, image: null, siteName: null };
  let value: LinkPreview;
  try {
    const response = await guarded(key, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "agent-swarm-link-preview/1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !/html/i.test(type)) {
      await response.body?.cancel().catch(() => {});
      value = { url: key, ok: false, ...empty };
    } else {
      const parsed = parseOpenGraph(
        await readCapped(response, MAX_HTML_BYTES),
        response.url || key,
      );
      value = { url: key, ok: parsed.title !== null, ...parsed };
    }
  } catch (error) {
    if (error instanceof LinkPreviewRefusedError) throw error;
    // A name that resolves to a private address is refused; one that does not resolve is a dead link.
    if (error instanceof EgressDeniedError && /private or loopback/.test(error.message)) {
      throw new LinkPreviewRefusedError(error.message);
    }
    value = { url: key, ok: false, ...empty };
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now(), value });
  return value;
}
