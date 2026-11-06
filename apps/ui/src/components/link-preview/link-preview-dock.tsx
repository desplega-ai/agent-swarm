/**
 * The link preview inside a page's body, as T3 Code places its preview panel
 * in the chat view: the last column of the page's own row, under the app
 * header, with a drag edge on its left. The page keeps its layout next to it
 * (the task page keeps the transcript and the details card). The width is
 * stored per page kind when a drag or a key press ends.
 *
 * It stays inline while the row keeps `siblingMinWidth` for the page's
 * content; otherwise, or while the row is hidden (the task page under its
 * wide breakpoint), the preview opens as a sheet over the page.
 */

import { type CSSProperties, useCallback, useId, useLayoutEffect, useState } from "react";
import { useOptionalContextPanel } from "@/components/context-panel/context-panel-state";
import { ResizeHandle } from "@/components/shared/resize-handle";
import { useCollapseNavWhile } from "@/hooks/use-collapse-nav-while";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  clampPreviewWidth,
  PREVIEW_DEFAULT_WIDTH,
  PREVIEW_WIDTH_STEP,
  previewDockLayout,
} from "@/lib/link-preview-dock";
import { cn } from "@/lib/utils";
import { LinkPreviewContent, LinkPreviewSheet } from "./link-preview-panel";
import { useLinkPreviewScope } from "./link-preview-state";

/**
 * From `DOCK_QUERY` up to `WIDE_QUERY`, an open preview collapses the global
 * nav to icons, so the page keeps room for it inline. Below that, the page has
 * no room either way, and the preview opens as a sheet over it.
 */
const DOCK_QUERY = "(min-width: 1280px)";
const WIDE_QUERY = "(min-width: 1440px)";

function readStoredWidth(key: string): number | null {
  try {
    const stored = Number(localStorage.getItem(key));
    return stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** The row the dock shares and the window, measured before paint and on resize. */
function useRowSize(row: HTMLElement | null) {
  const [size, setSize] = useState<{ row: number; viewport: number } | null>(null);
  useLayoutEffect(() => {
    if (!row) return;
    const measure = () => setSize({ row: row.clientWidth, viewport: window.innerWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [row]);
  return size;
}

export function LinkPreviewDock({
  storageKey,
  siblingMinWidth,
  className,
}: {
  /** localStorage key for the width, one per page kind. */
  storageKey: string;
  /** The room the page's content needs next to the preview. */
  siblingMinWidth: number;
  className?: string;
}) {
  const panel = useOptionalContextPanel();
  const scope = useLinkPreviewScope();
  const target = panel?.preview ?? null;
  const [host, setHost] = useState<HTMLElement | null>(null);
  const size = useRowSize(host?.parentElement ?? null);
  const [stored, setStored] = useState(() => readStoredWidth(storageKey));
  const canDock = useMediaQuery(DOCK_QUERY);
  const isWide = useMediaQuery(WIDE_QUERY);
  const panelId = useId();

  // While mounted, this dock shows the scope's preview instead of its sheet.
  const registerDock = scope?.registerDock;
  useLayoutEffect(() => registerDock?.(), [registerDock]);

  const layout = size
    ? previewDockLayout({
        rowWidth: size.row,
        viewportWidth: size.viewport,
        siblingMinWidth,
      })
    : null;
  const inline = !!target && !!layout?.inline;
  const width = layout ? clampPreviewWidth(stored, layout) : PREVIEW_DEFAULT_WIDTH;
  useCollapseNavWhile(!!target && canDock && !isWide);

  const onResize = useCallback(
    (next: number, save: boolean) => {
      if (!layout) return;
      const clamped = clampPreviewWidth(next, layout);
      setStored(clamped);
      if (!save) return;
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        // Storage off: the width holds until a reload.
      }
    },
    [layout, storageKey],
  );

  const close = panel?.closePreview;
  return (
    <>
      {/* Always mounted: it measures the row it shares, even with no preview. */}
      <aside
        ref={setHost}
        id={panelId}
        aria-label="Link preview"
        style={{ "--link-preview-w": `${width}px` } as CSSProperties}
        className={cn(
          inline
            ? "relative flex h-full min-h-0 w-(--link-preview-w) shrink-0 flex-col border-l border-border"
            : "hidden",
          className,
        )}
      >
        {inline && target && close && layout ? (
          <>
            <ResizeHandle
              edge="left"
              width={width}
              min={layout.min}
              max={layout.max}
              defaultWidth={PREVIEW_DEFAULT_WIDTH}
              step={PREVIEW_WIDTH_STEP}
              onResize={onResize}
              label="Resize the preview"
              controls={panelId}
            />
            <LinkPreviewContent target={target} onClose={close} />
          </>
        ) : null}
      </aside>
      {target && close && layout && !layout.inline ? (
        <LinkPreviewSheet target={target} onClose={close} />
      ) : null}
    </>
  );
}
