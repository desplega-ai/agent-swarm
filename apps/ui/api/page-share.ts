/**
 * Crawler view of `/pages/:id`. `vercel.json` rewrites link-preview bots
 * (Slackbot, Twitterbot, LinkedInBot, ...) here; people get the SPA as before.
 *
 * Answers with the page's own Open Graph tags when the swarm API reports it as
 * public, else the generic dashboard card. The API origin is `SWARM_API_URL`,
 * else the SPA's `VITE_API_URL`; with neither, every page gets the generic card.
 */
import { buildPageShareHtml, resolveShareApiUrl } from "../src/lib/page-share";

export const config = { runtime: "edge" };

/**
 * Never stored by a shared cache: the page can turn private at any time, and
 * this crawler view shares its URL with the SPA that browsers get (`vercel.json`
 * also sends `Vary: User-Agent` on `/pages/:id`).
 */
const SHARE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  Vary: "User-Agent",
  "X-Robots-Tag": "noindex",
} as const;

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { html } = await buildPageShareHtml({
    origin: url.origin,
    id: url.searchParams.get("id"),
    apiUrl: resolveShareApiUrl(process.env),
  });
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: SHARE_HEADERS,
  });
}
