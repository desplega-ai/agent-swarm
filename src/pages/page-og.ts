/**
 * Share-preview (Open Graph / Twitter card) tags for public pages.
 *
 * `/p/:id` injects these into a public HTML page so a link unfurl shows the
 * page's own title, description and card. The API renders that card itself
 * (`/p/:id/og.png`, `src/pages/page-og-card.ts`), so it needs no dashboard.
 * Non-public pages never get these tags: their title and description must not
 * reach an unauthenticated crawler.
 */

/** Longest description sent in a tag or the card URL; the card clips it further. */
const MAX_DESCRIPTION = 200;

export interface PageShareMeta {
  title: string;
  description: string | null;
  /** Absolute card URL, or null for a text-only preview. */
  imageUrl: string | null;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Cut at a word boundary and add an ellipsis. */
export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** The API's own card for a page: `<apiBase>/p/<id>/og.png`. */
export function pageOgImageUrl(apiBaseUrl: string, pageId: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/p/${encodeURIComponent(pageId)}/og.png`;
}

export function buildPageShareMeta(
  page: { title: string; description?: string | null },
  imageUrl: string | null,
): PageShareMeta {
  const description = page.description?.trim() ? clipText(page.description, MAX_DESCRIPTION) : null;
  return { title: page.title, description, imageUrl };
}

/** True when the body already sets its own `og:title`; the author's tags win. */
export function declaresOpenGraph(body: string): boolean {
  return /<meta\b[^>]*\bproperty\s*=\s*["']?og:title\b/i.test(body);
}

/** `<meta>` tags for Open Graph and Twitter cards. */
export function renderPageShareMeta(meta: PageShareMeta): string {
  const tags: [string, string, string][] = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", "Agent Swarm"],
    ["property", "og:title", meta.title],
  ];
  if (meta.description) tags.push(["property", "og:description", meta.description]);
  if (meta.imageUrl) {
    tags.push(
      ["property", "og:image", meta.imageUrl],
      ["property", "og:image:width", "1200"],
      ["property", "og:image:height", "630"],
      ["property", "og:image:alt", meta.title],
    );
  }
  tags.push(
    ["name", "twitter:card", meta.imageUrl ? "summary_large_image" : "summary"],
    ["name", "twitter:title", meta.title],
  );
  if (meta.description) tags.push(["name", "twitter:description", meta.description]);
  if (meta.imageUrl) tags.push(["name", "twitter:image", meta.imageUrl]);
  return tags
    .map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeAttr(value)}">`)
    .join("");
}
