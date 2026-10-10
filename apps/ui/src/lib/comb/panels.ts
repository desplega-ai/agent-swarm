// The two side panels of a Comb page. The left panel has two tabs (Files, and
// Outline for a file with headings). The right panel holds the comments. From
// `md` up each panel sits beside the content and collapses to an icon strip.
// Below `md` both are sheets.
//
// The person's choice lives in localStorage, one key per panel, namespaced by
// the swarm API URL like the other Comb keys. Until the person chooses, the
// viewport width decides (`LEFT_OPEN_QUERY`, `RIGHT_OPEN_QUERY`).
//
// Relative imports only: `bun:test` runs this from the repo root.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";
import type { DraftStorage } from "./drafts";

/** From this width up the panels sit beside the content. Below it they are sheets. */
export const PANELS_INLINE_QUERY = "(min-width: 768px)";
/** The left panel starts open from this width up. */
export const LEFT_OPEN_QUERY = "(min-width: 1440px)";
/** The right panel starts open from this width up. */
export const RIGHT_OPEN_QUERY = "(min-width: 1024px)";

export type LeftTab = "files" | "outline";

/**
 * What the route shows, for the left panel: a folder, a file with an outline
 * (`outline`), or a file without one (`plain`: an image, a CSV, code, or
 * markdown with fewer than two headings).
 */
export type PanelTarget = "folder" | "outline" | "plain";

export interface LeftPanelState {
  /** Open or collapsed by hand. Null until the person chooses: the width decides. */
  open: boolean | null;
  /** The tab for a file with an outline. Folders and other files show Files. */
  tab: LeftTab;
  /** Collapsed for the current file only, because it has no outline. Not stored. */
  autoCollapsed: boolean;
}

export type LeftPanelEvent =
  /** The route resolved to `target`. `first`: the first route since the page loaded. */
  | { type: "navigate"; target: PanelTarget; first: boolean }
  /** The person opened the panel on `tab` (a strip icon or the toggle). */
  | { type: "show"; tab: LeftTab; target: PanelTarget }
  /** The person picked a tab (the open panel, or the phone sheet: the open state stays). */
  | { type: "select"; tab: LeftTab; target: PanelTarget }
  /** The person collapsed the panel. */
  | { type: "collapse" };

export const INITIAL_LEFT_PANEL: LeftPanelState = {
  open: null,
  tab: "outline",
  autoCollapsed: false,
};

/**
 * - Opening a file with an outline switches to Outline. The first route keeps
 *   the stored tab, so a reload shows the tab the person left.
 * - Opening a file without an outline collapses the panel for that file only.
 * - Opening a folder shows Files and undoes that collapse. A collapse by hand stays.
 * - A tab picked by hand is stored only where Outline exists, so Files on a
 *   folder does not turn off the outline for the next file.
 */
export function leftPanelReducer(state: LeftPanelState, event: LeftPanelEvent): LeftPanelState {
  switch (event.type) {
    case "navigate":
      if (event.target === "plain") return { ...state, autoCollapsed: true };
      if (event.target === "outline" && !event.first) {
        return { ...state, tab: "outline", autoCollapsed: false };
      }
      return { ...state, autoCollapsed: false };
    case "show":
      return {
        open: true,
        tab: event.target === "outline" ? event.tab : state.tab,
        autoCollapsed: false,
      };
    case "select":
      return event.target === "outline" ? { ...state, tab: event.tab } : state;
    case "collapse":
      return { ...state, open: false, autoCollapsed: false };
  }
}

export interface LeftPanelView {
  open: boolean;
  tab: LeftTab;
  /** The Outline tab exists. */
  outline: boolean;
}

/** What the left panel shows now. `wide`: the viewport matches `LEFT_OPEN_QUERY`. */
export function leftPanelView(
  state: LeftPanelState,
  target: PanelTarget,
  wide: boolean,
): LeftPanelView {
  const outline = target === "outline";
  return {
    open: (state.open ?? wide) && !state.autoCollapsed,
    tab: outline ? state.tab : "files",
    outline,
  };
}

/** Whether the right panel is open. `wide`: the viewport matches `RIGHT_OPEN_QUERY`. */
export function rightPanelOpen(stored: boolean | null, wide: boolean): boolean {
  return stored ?? wide;
}

export const LEFT_PANEL_KEY = "comb:panel:left";
export const RIGHT_PANEL_KEY = "comb:panel:right";

function readJson(storage: DraftStorage | null, key: string): Record<string, unknown> | null {
  try {
    const raw = storage?.getItem(key);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: DraftStorage | null, key: string, value: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked localStorage only forgets the panel state.
  }
}

/** The stored left panel (open and tab), or the initial state. */
export function readLeftPanel(storage: DraftStorage | null, apiUrl: string): LeftPanelState {
  const stored = readJson(storage, deriveStorageKey(apiUrl, LEFT_PANEL_KEY));
  return {
    open: typeof stored?.open === "boolean" ? stored.open : null,
    tab: stored?.tab === "files" ? "files" : "outline",
    autoCollapsed: false,
  };
}

export function writeLeftPanel(
  storage: DraftStorage | null,
  apiUrl: string,
  state: Pick<LeftPanelState, "open" | "tab">,
) {
  const value = state.open === null ? { tab: state.tab } : { open: state.open, tab: state.tab };
  writeJson(storage, deriveStorageKey(apiUrl, LEFT_PANEL_KEY), value);
}

/** The stored right panel choice, or null when the person has not chosen. */
export function readRightPanel(storage: DraftStorage | null, apiUrl: string): boolean | null {
  const stored = readJson(storage, deriveStorageKey(apiUrl, RIGHT_PANEL_KEY));
  return typeof stored?.open === "boolean" ? stored.open : null;
}

export function writeRightPanel(storage: DraftStorage | null, apiUrl: string, open: boolean) {
  writeJson(storage, deriveStorageKey(apiUrl, RIGHT_PANEL_KEY), { open });
}
