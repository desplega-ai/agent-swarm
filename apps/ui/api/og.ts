/**
 * GET /api/og?title=&subtitle=[&accent=]: the 1200x630 page share card
 * (`src/lib/page-og-card.ts`), the agent-swarm.dev landing card ported here so
 * a self-hosted dashboard renders its own previews.
 *
 * Vercel Edge Function. Fonts and images are bundled through literal
 * `new URL(..., import.meta.url)` references. A missing asset degrades the
 * card (default font, no mascot) instead of failing the share preview.
 */
import { ImageResponse } from "@vercel/og";
import { MONO, pageOgCard, SANS } from "../src/lib/page-og-card";
import { OG_SIZE, parseOgParams } from "../src/lib/page-share";

export const config = { runtime: "edge" };

type Font = { name: string; data: ArrayBuffer; weight: 400 | 500; style: "normal" };

// `url` is a thunk: a runtime that cannot resolve `import.meta.url` (such as
// `vercel dev`) throws from `new URL`, and that must cost the asset, not the card.
const load = (url: () => URL): Promise<ArrayBuffer | null> => {
  try {
    return fetch(url())
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
};

// Literal URLs only: the bundler resolves each `new URL(<literal>, import.meta.url)`.
const assets = Promise.all([
  load(() => new URL("../og/fonts/space-grotesk-400.ttf", import.meta.url)),
  load(() => new URL("../og/fonts/space-grotesk-500.ttf", import.meta.url)),
  load(() => new URL("../og/fonts/space-mono-400.ttf", import.meta.url)),
  load(() => new URL("../public/logo.png", import.meta.url)),
  load(() => new URL("../og/mascot-lead.png", import.meta.url)),
]);

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const input = parseOgParams(new URL(request.url).searchParams);
  const [g400, g500, m400, logo, mascot] = await assets;
  const fonts: Font[] = [];
  if (g400) fonts.push({ name: SANS, data: g400, weight: 400, style: "normal" });
  if (g500) fonts.push({ name: SANS, data: g500, weight: 500, style: "normal" });
  if (m400) fonts.push({ name: MONO, data: m400, weight: 400, style: "normal" });

  const card = pageOgCard({ input, logo, mascot });
  return new ImageResponse(card as unknown as ConstructorParameters<typeof ImageResponse>[0], {
    ...OG_SIZE,
    // ImageResponse caches for a year; the URL carries all of the card text.
    ...(fonts.length > 0 ? { fonts } : {}),
  });
}
