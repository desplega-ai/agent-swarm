/**
 * `Drawer presentation: "split"`: the route-driven Drawer rendered inline as a
 * right pane beside the page canvas instead of as a sheet.
 *
 * The app surface owns the detail region (`SplitDetailRegion`): a row with the
 * canvas and an empty slot. A split Drawer portals its pane into the slot, so
 * the canvas shrinks while it is open. The pane width is the viewer's: it is
 * stored in `localStorage` under the surface's `storageKey` plus the Drawer's
 * param. Without a region (the DB-backed pages renderer) or below `md`, the
 * Drawer falls back to its sheet.
 *
 * `useRouteParamPanel` is the open/close contract shared by every
 * route-driven panel (sheet Drawer, split Drawer, Dialog): open exactly while
 * `/route/params/<param>` is set; closing removes the param with a history
 * REPLACE, so Back never re-opens a dismissed panel.
 */

import { getByPath } from "@json-render/core";
import { useStateStore } from "@json-render/react";
import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clampWidth, ResizeHandle } from "./resize-handle";

export type PanelSize = "sm" | "md" | "lg" | "xl";

/** Default pane width per Drawer `size`, in px. */
export const SPLIT_DEFAULT_WIDTH: Record<PanelSize, number> = {
  sm: 360,
  md: 480,
  lg: 640,
  xl: 800,
};
export const SPLIT_MIN_WIDTH = 280;
/** The canvas keeps at least this share of the region. */
const SPLIT_MAX_SHARE = 0.7;

export function useRouteParamPanel(param: string): { open: boolean; close: () => void } {
  const { state } = useStateStore();
  const [, setSearchParams] = useSearchParams();
  const value = getByPath(state, `/route/params/${param}`);
  const open = value !== undefined && value !== null && value !== "";
  const close = useCallback(() => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete(param);
        return params;
      },
      { replace: true },
    );
  }, [param, setSearchParams]);
  return { open, close };
}

interface SplitDetailContextValue {
  /** The slot a split Drawer portals into; null until mounted. */
  slot: HTMLElement | null;
  /** The region's width, the bound for the pane's max width. */
  regionWidth: number;
  /** `localStorage` key prefix for pane widths (per app, per viewer). */
  storageKey: string;
}

const SplitDetailContext = createContext<SplitDetailContextValue | null>(null);

export function useSplitDetailRegion(): SplitDetailContextValue | null {
  return useContext(SplitDetailContext);
}

/** Whether a page's elements hold a `presentation: "split"` Drawer. */
export function pageHasSplitDrawer(elements: unknown): boolean {
  if (!elements || typeof elements !== "object") return false;
  return Object.values(elements as Record<string, unknown>).some((element) => {
    const el = element as { type?: unknown; props?: { presentation?: unknown } } | null;
    return el?.type === "Drawer" && el.props?.presentation === "split";
  });
}

/**
 * The canvas plus the split pane slot. `fill` pages keep their definite
 * height (the row stretches, the pane spans it); other pages scroll as a
 * whole, so the slot is sticky and as tall as the scroll container's visible
 * area.
 */
export function SplitDetailRegion({
  storageKey,
  fill,
  scrollRef,
  children,
}: {
  storageKey: string;
  fill: boolean;
  scrollRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [region, setRegion] = useState<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [regionWidth, setRegionWidth] = useState(0);
  const [viewHeight, setViewHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!region) return;
    const scroller = scrollRef?.current ?? null;
    const measure = () => {
      setRegionWidth(region.clientWidth);
      if (!scroller) return;
      const style = getComputedStyle(scroller);
      const padding =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
      setViewHeight(Math.max(0, scroller.clientHeight - padding));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  }, [region, scrollRef]);

  return (
    <SplitDetailContext.Provider value={{ slot, regionWidth, storageKey }}>
      <div
        ref={setRegion}
        className={cn("flex min-w-0 flex-1", fill ? "min-h-0 items-stretch" : "items-start")}
        data-testid="split-detail-region"
      >
        <div className={cn("flex min-w-0 flex-1 flex-col", fill && "min-h-0")}>{children}</div>
        <div
          ref={setSlot}
          className={cn("flex shrink-0 max-md:hidden", fill ? "min-h-0" : "sticky top-0")}
          style={!fill && viewHeight ? { height: viewHeight } : undefined}
          data-testid="split-detail-slot"
        />
      </div>
    </SplitDetailContext.Provider>
  );
}

function readWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeWidth(key: string, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(width));
  } catch {
    /* storage full or blocked: the width just does not persist */
  }
}

export function splitWidthKey(storageKey: string, param: string): string {
  return `${storageKey}:${param}`;
}

/** The inline pane: resize edge, header with close, scrolling body, footer. */
export function SplitDrawerPane({
  region,
  param,
  size,
  title,
  description,
  onClose,
  footer,
  children,
}: {
  region: SplitDetailContextValue & { slot: HTMLElement };
  param: string;
  size: PanelSize;
  title?: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const key = splitWidthKey(region.storageKey, param);
  const fallback = SPLIT_DEFAULT_WIDTH[size];
  const [width, setWidth] = useState(() => readWidth(key) ?? fallback);
  useEffect(() => {
    setWidth(readWidth(key) ?? fallback);
  }, [key, fallback]);
  const max = region.regionWidth > 0 ? region.regionWidth * SPLIT_MAX_SHARE : fallback * 2;
  const shown = clampWidth(width, SPLIT_MIN_WIDTH, max);
  const label = title ?? "Details";

  return createPortal(
    <aside
      aria-label={label}
      className="flex h-full min-h-0 border-l border-border bg-background"
      style={{ width: shown }}
      data-testid="json-render-drawer-split"
    >
      <ResizeHandle
        width={shown}
        min={SPLIT_MIN_WIDTH}
        max={Math.max(SPLIT_MIN_WIDTH, Math.round(max))}
        label={`Resize ${label}`}
        className="-ml-0.75"
        onResize={setWidth}
        onCommit={(next) => writeWidth(key, next)}
        onReset={() => {
          setWidth(fallback);
          writeWidth(key, null);
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-start gap-2 border-b border-border py-3 pl-4 pr-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium">{label}</h2>
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Close ${label}`}
            onClick={onClose}
            data-testid="json-render-drawer-split-close"
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
        {footer}
      </div>
    </aside>,
    region.slot,
  );
}
