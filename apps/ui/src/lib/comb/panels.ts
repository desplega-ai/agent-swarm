// The two side panels of a Comb page. The left panel has tabs Files, Recent
// and Favorites. The right panel has Comments and, for a file with headings,
// Outline (like the agent-fs live UI). From `md` up each panel sits beside the
// content and collapses to an icon strip. Below `md` both are sheets.
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

/** The left panel's tabs, in order. */
export const LEFT_TABS = ["files", "recent", "favorites"] as const;
export type LeftTab = (typeof LEFT_TABS)[number];

/** The right panel's tabs, in order. Outline shows only for a file with headings. */
export const RIGHT_TABS = ["comments", "outline"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

function isLeftTab(value: unknown): value is LeftTab {
  return (LEFT_TABS as readonly unknown[]).includes(value);
}

function isRightTab(value: unknown): value is RightTab {
  return (RIGHT_TABS as readonly unknown[]).includes(value);
}

/** What the route shows: the drive root (`home`, the Comb home), another folder, or a file. */
export type PanelTarget = "home" | "folder" | "file";

export interface LeftPanelState {
  /** Open or collapsed by hand. Null until the person chooses: the width decides. */
  open: boolean | null;
  tab: LeftTab;
  /** Collapsed for the current page only (the drive root). Not stored. */
  autoCollapsed: boolean;
}

export type LeftPanelEvent =
  /** The route resolved to `target`. */
  | { type: "navigate"; target: PanelTarget }
  /** The person opened the panel on `tab` (a strip icon or the toggle). */
  | { type: "show"; tab: LeftTab }
  /** The person picked a tab (the open panel, or the phone sheet: the open state stays). */
  | { type: "select"; tab: LeftTab }
  /** The person collapsed the panel. */
  | { type: "collapse" };

export const INITIAL_LEFT_PANEL: LeftPanelState = {
  open: null,
  tab: "files",
  autoCollapsed: false,
};

/**
 * - Opening the drive root collapses the panel for that page only: the Comb
 *   home lists the files itself. Any other page undoes that collapse.
 * - Files and folders never change the tab or collapse the panel: the tree
 *   stays while the person moves between files.
 * - A collapse by hand stays.
 */
export function leftPanelReducer(state: LeftPanelState, event: LeftPanelEvent): LeftPanelState {
  switch (event.type) {
    case "navigate": {
      const autoCollapsed = event.target === "home";
      return autoCollapsed === state.autoCollapsed ? state : { ...state, autoCollapsed };
    }
    case "show":
      return { open: true, tab: event.tab, autoCollapsed: false };
    case "select":
      return event.tab === state.tab ? state : { ...state, tab: event.tab };
    case "collapse":
      return { ...state, open: false, autoCollapsed: false };
  }
}

export interface LeftPanelView {
  open: boolean;
  tab: LeftTab;
}

/** What the left panel shows now. `wide`: the viewport matches `LEFT_OPEN_QUERY`. */
export function leftPanelView(state: LeftPanelState, wide: boolean): LeftPanelView {
  return { open: (state.open ?? wide) && !state.autoCollapsed, tab: state.tab };
}

export interface RightPanelState {
  /** Open or collapsed by hand. Null until the person chooses: the width decides. */
  open: boolean | null;
  tab: RightTab;
}

export const INITIAL_RIGHT_PANEL: RightPanelState = { open: null, tab: "comments" };

export interface RightPanelView {
  open: boolean;
  tab: RightTab;
  /** The Outline tab exists. */
  outline: boolean;
}

/**
 * What the right panel shows now. `wide`: the viewport matches
 * `RIGHT_OPEN_QUERY`. `outline`: the file has an outline. Outline picked on
 * a file without one reads as Comments, and comes back on the next file
 * that has one.
 */
export function rightPanelView(
  state: RightPanelState,
  wide: boolean,
  outline: boolean,
): RightPanelView {
  return {
    open: state.open ?? wide,
    tab: outline ? state.tab : "comments",
    outline,
  };
}

export const LEFT_PANEL_KEY = "comb:panel:left";
export const RIGHT_PANEL_KEY = "comb:panel:right";
/** Full width: a markdown file's text as wide as its pane. The side panels stay. */
export const FULL_WIDTH_KEY = "comb:full-width";

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

/** The stored left panel (open and tab), or the initial state. A stored Outline reads as Files. */
export function readLeftPanel(storage: DraftStorage | null, apiUrl: string): LeftPanelState {
  const stored = readJson(storage, deriveStorageKey(apiUrl, LEFT_PANEL_KEY));
  return {
    open: typeof stored?.open === "boolean" ? stored.open : null,
    tab: isLeftTab(stored?.tab) ? stored.tab : "files",
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

/** The stored right panel (open and tab), or the initial state. */
export function readRightPanel(storage: DraftStorage | null, apiUrl: string): RightPanelState {
  const stored = readJson(storage, deriveStorageKey(apiUrl, RIGHT_PANEL_KEY));
  return {
    open: typeof stored?.open === "boolean" ? stored.open : INITIAL_RIGHT_PANEL.open,
    tab: isRightTab(stored?.tab) ? stored.tab : INITIAL_RIGHT_PANEL.tab,
  };
}

export function writeRightPanel(
  storage: DraftStorage | null,
  apiUrl: string,
  state: RightPanelState,
) {
  const value = state.open === null ? { tab: state.tab } : { open: state.open, tab: state.tab };
  writeJson(storage, deriveStorageKey(apiUrl, RIGHT_PANEL_KEY), value);
}

/** The stored full width choice. Off until the person turns it on. */
export function readFullWidth(storage: DraftStorage | null, apiUrl: string): boolean {
  return readJson(storage, deriveStorageKey(apiUrl, FULL_WIDTH_KEY))?.on === true;
}

export function writeFullWidth(storage: DraftStorage | null, apiUrl: string, on: boolean) {
  writeJson(storage, deriveStorageKey(apiUrl, FULL_WIDTH_KEY), { on });
}

/** The markdown frontmatter block ("Properties"): open until the person collapses it. */
export const PROPERTIES_OPEN_KEY = "comb:properties-open";

export function readPropertiesOpen(storage: DraftStorage | null, apiUrl: string): boolean {
  return readJson(storage, deriveStorageKey(apiUrl, PROPERTIES_OPEN_KEY))?.open !== false;
}

export function writePropertiesOpen(storage: DraftStorage | null, apiUrl: string, open: boolean) {
  writeJson(storage, deriveStorageKey(apiUrl, PROPERTIES_OPEN_KEY), { open });
}
