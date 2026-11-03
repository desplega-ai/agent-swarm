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

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { html, matched } = await buildPageShareHtml({
    origin: url.origin,
    id: url.searchParams.get("id"),
    apiUrl: resolveShareApiUrl(process.env),
  });
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // A miss may be a transient API failure: do not let crawlers keep it long.
      "Cache-Control": matched ? "public, max-age=300" : "public, max-age=60",
      "X-Robots-Tag": "noindex",
    },
  });
}
