// Sizing for the link preview panel inside a page (T3 Code's preview panel
// pattern): it sits in the page's own row, next to the content it previews,
// with a drag edge. It stays inline while the row keeps room for the page's
// content beside it; otherwise it opens as a sheet over the page.
//
// Relative imports only: `bun:test` runs this from the repo root.

export const PREVIEW_MIN_WIDTH = 360;
export const PREVIEW_DEFAULT_WIDTH = 480;
/** The panel never takes more than this share of the window. */
export const PREVIEW_MAX_VIEWPORT_FRACTION = 0.7;
export const PREVIEW_WIDTH_STEP = 16;

export interface PreviewDockLayout {
  /** Inline in the row; false means a sheet over the page. */
  inline: boolean;
  min: number;
  /** The widest the panel may get, never under `min`. */
  max: number;
}

/**
 * `rowWidth` is the row the panel shares (0 when the row is hidden, as the
 * task page's wide layout is under its breakpoint). `siblingMinWidth` is the
 * room the page's content needs next to the panel.
 */
export function previewDockLayout({
  rowWidth,
  viewportWidth,
  siblingMinWidth,
}: {
  rowWidth: number;
  viewportWidth: number;
  siblingMinWidth: number;
}): PreviewDockLayout {
  const room = Math.floor(rowWidth - siblingMinWidth);
  const viewportCap = Math.floor(viewportWidth * PREVIEW_MAX_VIEWPORT_FRACTION);
  // Keep max >= min: an inverted clamp would overwrite the saved width.
  const max = Math.max(PREVIEW_MIN_WIDTH, Math.min(room, viewportCap));
  return { inline: room >= PREVIEW_MIN_WIDTH, min: PREVIEW_MIN_WIDTH, max };
}

/** A width inside the layout's bounds; the default for a missing or bad value. */
export function clampPreviewWidth(width: number | null, layout: PreviewDockLayout): number {
  const value =
    width !== null && Number.isFinite(width) && width > 0 ? width : PREVIEW_DEFAULT_WIDTH;
  return Math.round(Math.min(layout.max, Math.max(layout.min, value)));
}
