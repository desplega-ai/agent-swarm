import { describe, expect, test } from "bun:test";
import type { DraftStorage } from "./drafts";
import {
  INITIAL_LEFT_PANEL,
  type LeftPanelEvent,
  type LeftPanelState,
  leftPanelReducer,
  leftPanelView,
  readLeftPanel,
  readRightPanel,
  rightPanelOpen,
  writeLeftPanel,
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
    expect(leftPanelView(INITIAL_LEFT_PANEL, "folder", true).open).toBe(true);
    expect(leftPanelView(INITIAL_LEFT_PANEL, "folder", false).open).toBe(false);
  });

  test("a choice by hand wins over the width", () => {
    const opened = run(INITIAL_LEFT_PANEL, { type: "show", tab: "files", target: "folder" });
    expect(leftPanelView(opened, "folder", false).open).toBe(true);
    const collapsed = run(INITIAL_LEFT_PANEL, { type: "collapse" });
    expect(leftPanelView(collapsed, "folder", true).open).toBe(false);
  });
});

describe("auto-switch on navigation", () => {
  const folder = run(INITIAL_LEFT_PANEL, { type: "navigate", target: "folder", first: true });

  test("a folder shows Files", () => {
    expect(leftPanelView(folder, "folder", true)).toEqual({
      open: true,
      tab: "files",
      outline: false,
    });
  });

  test("opening a file with an outline switches to Outline", () => {
    const state = run(folder, { type: "navigate", target: "outline", first: false });
    expect(leftPanelView(state, "outline", true)).toEqual({
      open: true,
      tab: "outline",
      outline: true,
    });
  });

  test("opening a file without an outline collapses the panel, a folder opens it again", () => {
    const image = run(folder, { type: "navigate", target: "plain", first: false });
    expect(leftPanelView(image, "plain", true)).toEqual({
      open: false,
      tab: "files",
      outline: false,
    });
    const back = run(image, { type: "navigate", target: "folder", first: false });
    expect(leftPanelView(back, "folder", true).open).toBe(true);
    // The auto collapse was never stored.
    expect(back.open).toBeNull();
  });

  test("the person can reopen the panel on a file without an outline", () => {
    const image = run(folder, { type: "navigate", target: "plain", first: false });
    const reopened = run(image, { type: "show", tab: "files", target: "plain" });
    expect(leftPanelView(reopened, "plain", true)).toEqual({
      open: true,
      tab: "files",
      outline: false,
    });
  });

  test("a collapse by hand stays collapsed across files and folders", () => {
    const state = run(
      folder,
      { type: "collapse" },
      { type: "navigate", target: "outline", first: false },
    );
    expect(leftPanelView(state, "outline", true)).toEqual({
      open: false,
      tab: "outline",
      outline: true,
    });
    const next = run(state, { type: "navigate", target: "folder", first: false });
    expect(leftPanelView(next, "folder", true).open).toBe(false);
  });

  test("the person can pick Files on a file with an outline", () => {
    const state = run(
      folder,
      { type: "navigate", target: "outline", first: false },
      { type: "show", tab: "files", target: "outline" },
    );
    expect(leftPanelView(state, "outline", true).tab).toBe("files");
    // The next file with an outline switches to Outline again.
    const next = run(state, { type: "navigate", target: "outline", first: false });
    expect(leftPanelView(next, "outline", true).tab).toBe("outline");
  });

  test("picking a tab leaves the open state alone (the phone sheet)", () => {
    const state = run(
      INITIAL_LEFT_PANEL,
      { type: "navigate", target: "outline", first: true },
      { type: "select", tab: "files", target: "outline" },
    );
    expect(state.open).toBeNull();
    expect(leftPanelView(state, "outline", false)).toEqual({
      open: false,
      tab: "files",
      outline: true,
    });
    // A pick where Outline does not exist changes nothing.
    expect(run(state, { type: "select", tab: "outline", target: "folder" })).toBe(state);
  });

  test("Files picked on a folder keeps Outline for the next file", () => {
    const state = run(
      folder,
      { type: "show", tab: "files", target: "folder" },
      { type: "navigate", target: "outline", first: true },
    );
    expect(leftPanelView(state, "outline", true).tab).toBe("outline");
  });

  test("the first route keeps the stored tab (a reload)", () => {
    const stored: LeftPanelState = { open: true, tab: "files", autoCollapsed: false };
    const state = run(stored, { type: "navigate", target: "outline", first: true });
    expect(leftPanelView(state, "outline", true).tab).toBe("files");
  });
});

describe("right panel", () => {
  test("the stored choice wins over the width", () => {
    expect(rightPanelOpen(null, true)).toBe(true);
    expect(rightPanelOpen(null, false)).toBe(false);
    expect(rightPanelOpen(false, true)).toBe(false);
    expect(rightPanelOpen(true, false)).toBe(true);
  });
});

describe("panel storage", () => {
  const apiUrl = "http://localhost:3013";

  test("round trip, one key per panel, namespaced by the API URL", () => {
    const storage = memoryStorage();
    writeLeftPanel(storage, apiUrl, { open: false, tab: "files" });
    writeRightPanel(storage, apiUrl, true);
    expect([...storage.map.keys()].sort()).toEqual([
      `swarm:v1:${apiUrl}:comb:panel:left`,
      `swarm:v1:${apiUrl}:comb:panel:right`,
    ]);
    expect(readLeftPanel(storage, apiUrl)).toEqual({
      open: false,
      tab: "files",
      autoCollapsed: false,
    });
    expect(readRightPanel(storage, apiUrl)).toBe(true);
    expect(readRightPanel(storage, "http://other")).toBeNull();
  });

  test("no choice yet stores only the tab", () => {
    const storage = memoryStorage();
    writeLeftPanel(storage, apiUrl, { open: null, tab: "outline" });
    expect(readLeftPanel(storage, apiUrl)).toEqual(INITIAL_LEFT_PANEL);
  });

  test("missing, broken, or blocked storage reads as the initial state", () => {
    const storage = memoryStorage();
    storage.map.set(`swarm:v1:${apiUrl}:comb:panel:left`, "{not json");
    storage.map.set(`swarm:v1:${apiUrl}:comb:panel:right`, '{"open":"yes"}');
    expect(readLeftPanel(storage, apiUrl)).toEqual(INITIAL_LEFT_PANEL);
    expect(readRightPanel(storage, apiUrl)).toBeNull();
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
    expect(readRightPanel(blocked, apiUrl)).toBeNull();
    expect(() => writeRightPanel(blocked, apiUrl, true)).not.toThrow();
  });
});
