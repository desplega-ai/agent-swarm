import { useEffect, useState } from "react";

const SAMPLE = 32;
/** The winning color needs at least this share of the opaque pixels. */
const MIN_SHARE = 0.04;

/**
 * The main color of a logo as `#rrggbb`: the most common saturated color,
 * so white, black and gray backgrounds and text never win. Null while it
 * loads, for a logo with no such color, and when the logo host sends no CORS
 * header (the canvas cannot be read). The telemetry proxy's logo route sends
 * one for the hosted dashboard and for localhost.
 */
export function useLogoColor(url: string | null): string | null {
  const [result, setResult] = useState<{ url: string; color: string | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setResult({ url, color: mainColor(img) });
    };
    img.onerror = () => {
      if (!cancelled) setResult({ url, color: null });
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return url && result?.url === url ? result.color : null;
}

function mainColor(img: HTMLImageElement): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch {
    return null; // A cross-origin image without CORS taints the canvas.
  }
  // Bucket saturated pixels by color (3 bits a channel), then average the biggest bucket.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    opaque += 1;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 510;
    const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
    if (saturation < 0.35 || lightness < 0.15 || lightness > 0.85) continue;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best || best.count < opaque * MIN_SHARE) return null;
  const { count } = best;
  const hex = (sum: number) =>
    Math.round(sum / count)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}
