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

/** Raised when a {@link BoundedRenderQueue} is full. */
export class CardRendererBusyError extends Error {
  constructor() {
    super("page card renderer busy");
  }
}

/**
 * Runs jobs one at a time with at most `maxPending` waiting or running, and
 * shares one job between callers asking for the same key. Each job starts on a
 * fresh event-loop turn, so a queue of synchronous rasterizations never starves
 * the API's other requests.
 */
export class BoundedRenderQueue<T> {
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly maxPending: number) {}

  run(key: string, work: () => Promise<T>): Promise<T> {
    const shared = this.inflight.get(key);
    if (shared) return shared;
    if (this.pending >= this.maxPending) return Promise.reject(new CardRendererBusyError());
    this.pending++;
    const job = this.tail
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(work)
      .finally(() => {
        this.pending--;
        this.inflight.delete(key);
      });
    this.tail = job.catch(() => undefined);
    this.inflight.set(key, job);
    return job;
  }
}

/** The route is unauthenticated: a burst of card requests waits here or gets a 503. */
export const MAX_PENDING_RENDERS = 4;
export const cardQueue = new BoundedRenderQueue<Uint8Array>(MAX_PENDING_RENDERS);

/** Renders so far, for tests. */
export const pageOgCardStats = { renders: 0 };

async function draw(params: URLSearchParams): Promise<Uint8Array> {
  const { fonts, logo, mascot } = await loadAssets();
  const card = pageOgCard({ input: parseOgParams(params), logo, mascot });
  const svg = await satori(card as Parameters<typeof satori>[0], { ...OG_SIZE, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: OG_SIZE.width } }).render().asPng();
  pageOgCardStats.renders++;
  return png;
}

/**
 * The 1200x630 PNG card for a page title and description. Rejects with
 * {@link CardRendererBusyError} when the render queue is full.
 */
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
  const png = await cardQueue.run(key, () => draw(params));
  cache.set(key, png);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return png;
}
