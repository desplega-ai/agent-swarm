/**
 * Renders the page share card PNG on the API (`GET /p/:id/og.png`), so a
 * self-hosted swarm unfurls public pages with their own card without the
 * dashboard's Vercel functions. Same card as the dashboard's `api/og.ts`
 * (`apps/ui/og/page-card.ts`), drawn with Satori and rasterized with resvg's
 * WASM build.
 *
 * Loaded lazily by `src/http/pages-public.ts`: the fonts, images and WASM are
 * file imports, which `bun build --compile` embeds in the API binary, and none
 * of it is read until the first card is asked for.
 */
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasmPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };
import satori from "satori";
import grotesk400Path from "../../apps/ui/og/fonts/space-grotesk-400.ttf" with { type: "file" };
import grotesk500Path from "../../apps/ui/og/fonts/space-grotesk-500.ttf" with { type: "file" };
import mono400Path from "../../apps/ui/og/fonts/space-mono-400.ttf" with { type: "file" };
import mascotPath from "../../apps/ui/og/mascot-lead.png" with { type: "file" };
import { MONO, pageOgCard, SANS } from "../../apps/ui/og/page-card";
import logoPath from "../../apps/ui/public/logo.png" with { type: "file" };
import { OG_SIZE, pageCardParams, parseOgParams } from "../../apps/ui/src/lib/page-share";

type Font = { name: string; data: ArrayBuffer; weight: 400 | 500; style: "normal" };

interface CardAssets {
  fonts: Font[];
  logo: ArrayBuffer;
  mascot: ArrayBuffer;
}

let assets: Promise<CardAssets> | null = null;

function loadAssets(): Promise<CardAssets> {
  assets ??= (async (): Promise<CardAssets> => {
    const read = (path: string) => Bun.file(path).arrayBuffer();
    const [wasm, g400, g500, m400, logo, mascot] = await Promise.all([
      read(resvgWasmPath),
      read(grotesk400Path),
      read(grotesk500Path),
      read(mono400Path),
      read(logoPath),
      read(mascotPath),
    ]);
    await initWasm(wasm);
    return {
      fonts: [
        { name: SANS, data: g400, weight: 400, style: "normal" },
        { name: SANS, data: g500, weight: 500, style: "normal" },
        { name: MONO, data: m400, weight: 400, style: "normal" },
      ],
      logo,
      mascot,
    };
  })().catch((err) => {
    // Let the next request retry instead of caching the failure.
    assets = null;
    throw err;
  });
  return assets;
}

/** Recent cards by text. A crawler fetches one card a few times per unfurl. */
const CACHE_LIMIT = 32;
const cache = new Map<string, Uint8Array>();

/** The 1200x630 PNG card for a page title and description. */
export async function renderPageOgPng(
  title: string,
  description: string | null,
): Promise<Uint8Array> {
  const params = pageCardParams(title, description);
  const key = params.toString();
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const { fonts, logo, mascot } = await loadAssets();
  const card = pageOgCard({ input: parseOgParams(params), logo, mascot });
  const svg = await satori(card as Parameters<typeof satori>[0], { ...OG_SIZE, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: OG_SIZE.width } }).render().asPng();
  cache.set(key, png);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return png;
}
