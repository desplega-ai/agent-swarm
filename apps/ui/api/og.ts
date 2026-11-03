/**
 * GET /api/og?title=&subtitle=[&accent=]: the 1200x630 page share card
 * (`og/page-card.ts`), the agent-swarm.dev landing card ported here so
 * a self-hosted dashboard renders its own previews.
 *
 * Vercel Node.js function (not Edge): the Edge bundler turns
 * `new URL(<asset>, import.meta.url)` into blob-asset imports that a root-dir
 * (monorepo) deployment rejects, so the assets are read from disk instead and
 * shipped through `functions.includeFiles` in vercel.json. A missing asset
 * degrades the card (default font, no mascot) instead of failing the preview.
 */
// Node ESM runs this file unbundled, so relative imports carry `.js`.
import { readFile } from "node:fs/promises";
import { ImageResponse } from "@vercel/og";
import { MONO, pageOgCard, SANS } from "../og/page-card.js";
import { OG_SIZE, parseOgParams } from "../src/lib/page-share.js";

type Font = { name: string; data: ArrayBuffer; weight: 400 | 500; style: "normal" };

// `path` is relative to this file, so the URL is built inside the try: a
// runtime without a file `import.meta.url` costs the asset, not the card.
async function load(path: string): Promise<ArrayBuffer | null> {
  try {
    const bytes = await readFile(new URL(path, import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

const assets = Promise.all([
  load("../og/fonts/space-grotesk-400.ttf"),
  load("../og/fonts/space-grotesk-500.ttf"),
  load("../og/fonts/space-mono-400.ttf"),
  load("../public/logo.png"),
  load("../og/mascot-lead.png"),
]);

/** Vercel routes only the exported methods here; others get its 405. */
export async function GET(request: Request): Promise<Response> {
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
