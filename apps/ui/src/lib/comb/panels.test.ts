import { describe, expect, test } from "bun:test";
import type { DraftStorage } from "./drafts";
import {
  INITIAL_LEFT_PANEL,
  INITIAL_RIGHT_PANEL,
  type LeftPanelEvent,
  type LeftPanelState,
  leftPanelReducer,
  leftPanelView,
  readFullWidth,
  readLeftPanel,
  readPropertiesOpen,
  readRightPanel,
  rightPanelView,
  writeFullWidth,
  writeLeftPanel,
  writePropertiesOpen,
  writeRightPanel,
} from "./panels";

function memoryStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const run = (state: LeftPanelState, ...events: LeftPanelEvent[]) =>
  events.reduce(leftPanelReducer, state);

describe("left panel defaults", () => {
  test("until the person chooses, the width decides", () => {
    expect(leftPanelView(INITIAL_LEFT_PANEL, true).open).toBe(true);
    expect(leftPanelView(INITIAL_LEFT_PANEL, false).open).toBe(false);
    expect(INITIAL_LEFT_PANEL.tab).toBe("files");
  });

  test("a choice by hand wins over the width", () => {
    const opened = run(INITIAL_LEFT_PANEL, { type: "show", tab: "files" });
    expect(leftPanelView(opened, false).open).toBe(true);
    const collapsed = run(INITIAL_LEFT_PANEL, { type: "collapse" });
    expect(leftPanelView(collapsed, true).open).toBe(false);
  });
});

describe("left panel on navigation", () => {
  const open: LeftPanelState = { open: true, tab: "files", autoCollapsed: false };

  test("files and folders never move the tree", () => {
    const state = run(
      open,
      { type: "navigate", target: "file" },
      { type: "navigate", target: "folder" },
      { type: "navigate", target: "file" },
    );
    expect(state).toBe(open);
    expect(leftPanelView(state, true)).toEqual({ open: true, tab: "files" });
  });

  test("the drive root collapses the panel for that page only", () => {
    const stored: LeftPanelState = { open: true, tab: "recent", autoCollapsed: false };
    const home = run(stored, { type: "navigate", target: "home" });
    expect(leftPanelView(home, true)).toEqual({ open: false, tab: "recent" });
    expect(home.open).toBe(true);
    const reopened = run(home, { type: "show", tab: "files" });
    expect(leftPanelView(reopened, true).open).toBe(true);
    const inFolder = run(home, { type: "navigate", target: "folder" });
    expect(leftPanelView(inFolder, true).open).toBe(true);
    const inFile = run(home, { type: "navigate", target: "file" });
    expect(leftPanelView(inFile, true).open).toBe(true);
  });

  test("a collapse by hand stays collapsed across files and folders", () => {
    const state = run(
      open,
      { type: "collapse" },
      { type: "navigate", target: "file" },
      { type: "navigate", target: "folder" },
    );
    expect(leftPanelView(state, true).open).toBe(false);
  });

  test("picking a tab leaves the open state alone (the phone sheet)", () => {
    const state = run(INITIAL_LEFT_PANEL, { type: "select", tab: "favorites" });
    expect(state).toEqual({ open: null, tab: "favorites", autoCollapsed: false });
    expect(run(state, { type: "select", tab: "favorites" })).toBe(state);
  });

  test("the strip opens the panel on a tab anywhere", () => {
    const collapsed: LeftPanelState = { open: false, tab: "files", autoCollapsed: false };
    expect(run(collapsed, { type: "show", tab: "favorites" })).toEqual({
      open: true,
      tab: "favorites",
      autoCollapsed: false,
    });
  });
});

describe("right panel", () => {
  test("the stored choice wins over the width", () => {
    expect(rightPanelView(INITIAL_RIGHT_PANEL, true, false).open).toBe(true);
    expect(rightPanelView(INITIAL_RIGHT_PANEL, false, false).open).toBe(false);
    expect(rightPanelView({ open: false, tab: "comments" }, true, false).open).toBe(false);
    expect(rightPanelView({ open: true, tab: "comments" }, false, false).open).toBe(true);
  });

  test("Outline shows only on a file with an outline, and comes back on the next one", () => {
    const picked = { open: true, tab: "outline" } as const;
    expect(rightPanelView(picked, true, true)).toEqual({
      open: true,
      tab: "outline",
      outline: true,
    });
    expect(rightPanelView(picked, true, false)).toEqual({
      open: true,
      tab: "comments",
      outline: false,
    });
  });
});

describe("panel storage", () => {
  const apiUrl = "http://localhost:3013";

  test("round trip, one key per panel, namespaced by the API URL", () => {
    const storage = memoryStorage();
    writeLeftPanel(storage, apiUrl, { open: false, tab: "files" });
    writeRightPanel(storage, apiUrl, { open: true, tab: "outline" });
    expect([...storage.map.keys()].sort()).toEqual([
      `swarm:v1:${apiUrl}:comb:panel:left`,
      `swarm:v1:${apiUrl}:comb:panel:right`,
    ]);
    expect(readLeftPanel(storage, apiUrl)).toEqual({
      open: false,
      tab: "files",
      autoCollapsed: false,
    });
    expect(readRightPanel(storage, apiUrl)).toEqual({ open: true, tab: "outline" });
    expect(readRightPanel(storage, "http://other")).toEqual(INITIAL_RIGHT_PANEL);
  });

  test("every tab round-trips, and an unknown one (or the old Outline) reads as Files", () => {
    const storage = memoryStorage();
    for (const tab of ["files", "recent", "favorites"] as const) {
      writeLeftPanel(storage, apiUrl, { open: true, tab });
      expect(readLeftPanel(storage, apiUrl).tab).toBe(tab);
    }
    storage.map.set(`swarm:v1:${apiUrl}:comb:panel:left`, '{"tab":"outline"}');
    expect(readLeftPanel(storage, apiUrl).tab).toBe("files");
    // A right panel stored before it had tabs keeps its open state.
    storage.map.set(`swarm:v1:${apiUrl}:comb:panel:right`, '{"open":false}');
    expect(readRightPanel(storage, apiUrl)).toEqual({ open: false, tab: "comments" });
  });

  test("full width is off until turned on, and round-trips per API URL", () => {
    const storage = memoryStorage();
    expect(readFullWidth(storage, apiUrl)).toBe(false);
    writeFullWidth(storage, apiUrl, true);
    expect(readFullWidth(storage, apiUrl)).toBe(true);
    expect(readFullWidth(storage, "http://other")).toBe(false);
    writeFullWidth(storage, apiUrl, false);
    expect(readFullWidth(storage, apiUrl)).toBe(false);
    storage.map.set(`swarm:v1:${apiUrl}:comb:full-width`, '{"on":"yes"}');
    expect(readFullWidth(storage, apiUrl)).toBe(false);
  });

  test("Properties is open until collapsed, and round-trips per API URL", () => {
    const storage = memoryStorage();
    expect(readPropertiesOpen(storage, apiUrl)).toBe(true);
    writePropertiesOpen(storage, apiUrl, false);
    expect(readPropertiesOpen(storage, apiUrl)).toBe(false);
    expect(readPropertiesOpen(storage, "http://other")).toBe(true);
    expect(readPropertiesOpen(null, apiUrl)).toBe(true);
  });

  test("no choice yet stores only the tab", () => {
    const storage = memoryStorage();
    writeLeftPanel(storage, apiUrl, { open: null, tab: "files" });
    expect(readLeftPanel(storage, apiUrl)).toEqual(INITIAL_LEFT_PANEL);
  });

  test("missing, broken, or blocked storage reads as the initial state", () => {
    const storage = memoryStorage();
    storage.map.set(`swarm:v1:${apiUrl}:comb:panel:left`, "{not json");
    storage.map.set(`swarm:v1:${apiUrl}:comb:panel:right`, '{"open":"yes"}');
    expect(readLeftPanel(storage, apiUrl)).toEqual(INITIAL_LEFT_PANEL);
    expect(readRightPanel(storage, apiUrl)).toEqual(INITIAL_RIGHT_PANEL);
    expect(readLeftPanel(null, apiUrl)).toEqual(INITIAL_LEFT_PANEL);
    const blocked: DraftStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(readRightPanel(blocked, apiUrl)).toEqual(INITIAL_RIGHT_PANEL);
    expect(() => writeRightPanel(blocked, apiUrl, { open: true, tab: "comments" })).not.toThrow();
  });
});
