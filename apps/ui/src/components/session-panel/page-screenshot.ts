/**
 * Captures the page behind the session panel as a PNG `File`, ready to go
 * through the composer's attachment path like any picked file.
 *
 * The page is rasterized from the DOM (`modern-screenshot`), so there is no
 * screen-share prompt and it works on mobile. Anything marked
 * `data-screenshot-exclude` (the panel itself, toasts) is left out.
 */

import { domToBlob } from "modern-screenshot";

/** Mark an element with this attribute to keep it out of page screenshots. */
export const SCREENSHOT_EXCLUDE_ATTR = "data-screenshot-exclude";

/** Longest output edge in pixels, so a 4K display does not produce a huge upload. */
const MAX_EDGE_PX = 2560;

export type RenderToBlob = (
  node: HTMLElement,
  options: {
    scale: number;
    backgroundColor: string | null;
    filter: (node: Node) => boolean;
    features: { restoreScrollPosition: boolean };
  },
) => Promise<Blob>;

export interface CapturePageOptions {
  /** Element to capture. */
  target: HTMLElement;
  /** Timestamp for the file name. */
  now?: Date;
  /** Device pixel ratio; defaults to `window.devicePixelRatio`. */
  pixelRatio?: number;
  /** Injected in tests; defaults to `modern-screenshot`'s `domToBlob`. */
  render?: RenderToBlob;
}

/** `screenshot-2026-09-28T23-11-06.png`: sortable, and allowed by the attachment filter. */
export function screenshotFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
  return `screenshot-${stamp}.png`;
}

/** Keeps the output's longest edge under `MAX_EDGE_PX`, never above 2x. */
export function screenshotScale(width: number, height: number, pixelRatio: number): number {
  const longest = Math.max(width, height, 1);
  return Math.max(0.1, Math.min(pixelRatio, 2, MAX_EDGE_PX / longest));
}

/** False for any element marked `data-screenshot-exclude`, which drops its subtree. */
export function keepInScreenshot(node: Node): boolean {
  // 1 = Node.ELEMENT_NODE, spelled out so this runs without a DOM global.
  return !(node.nodeType === 1 && (node as Element).hasAttribute(SCREENSHOT_EXCLUDE_ATTR));
}

function pageBackground(target: HTMLElement): string | null {
  for (const el of [target, document.body]) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
  }
  return null;
}

/** Stylesheets from another origin, e.g. the dashboard's Google Fonts link. */
export function crossOriginStylesheets(): string[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .map((link) => link.href)
    .filter((href) => {
      try {
        return new URL(href).origin !== window.location.origin;
      } catch {
        return false;
      }
    });
}

/**
 * Runs `fn` with each cross-origin stylesheet re-declared as an `@import` in a
 * same-origin `<style>`. The rasterizer embeds web fonts by reading the CSSOM,
 * which hides the rules of a cross-origin `<link>`; it does follow `@import`
 * rules, fetching them and inlining the font files. Without this, text in the
 * capture falls back to system fonts and wraps differently. The imports
 * repeat rules the page already has, so the page does not change.
 */
export async function withFontImports<T>(fn: () => Promise<T>): Promise<T> {
  const hrefs = crossOriginStylesheets();
  if (hrefs.length === 0) return fn();
  const style = document.createElement("style");
  style.textContent = hrefs.map((href) => `@import url(${JSON.stringify(href)});`).join("\n");
  document.head.appendChild(style);
  try {
    return await fn();
  } finally {
    style.remove();
  }
}

export async function capturePageScreenshot({
  target,
  now = new Date(),
  pixelRatio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  render = domToBlob,
}: CapturePageOptions): Promise<File> {
  const rect = target.getBoundingClientRect();
  const blob = await withFontImports(() =>
    render(target, {
      scale: screenshotScale(rect.width, rect.height, pixelRatio),
      backgroundColor: pageBackground(target),
      filter: keepInScreenshot,
      // Render scroll containers where the user left them, not at the top.
      features: { restoreScrollPosition: true },
    }),
  );
  return new File([blob], screenshotFileName(now), { type: "image/png" });
}
