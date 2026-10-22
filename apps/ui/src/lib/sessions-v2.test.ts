import { describe, expect, test } from "bun:test";
import type { AgentTask } from "../api/types";
import {
  closeSplit,
  closeTab,
  closeUrlTab,
  focusedTab,
  GROUP_TAB,
  isSessionTab,
  latestTask,
  NEW_SESSION_TAB,
  openTab,
  parseTabs,
  parseView,
  replaceTab,
  serializeTabs,
  splitTo,
  tabPath,
  tabsWithFocus,
  urlTabs,
  withGroupTab,
} from "./sessions-v2";

describe("sessions v2 URL state", () => {
  test("parseTabs trims, drops blanks and repeats, and keeps the order", () => {
    expect(parseTabs(null)).toEqual([]);
    expect(parseTabs(" a, ,b,a,new ")).toEqual(["a", "b", "new"]);
  });

  test("the focused tab joins the list when the URL lacks it", () => {
    expect(tabsWithFocus([], "a")).toEqual(["a"]);
    expect(tabsWithFocus(["a", "new"], "a")).toEqual(["a", "new"]);
    expect(tabsWithFocus(["a"], "b")).toEqual(["a", "b"]);
  });

  test("serializeTabs drops the param when the path already names the only tab", () => {
    expect(serializeTabs(["a"], "a")).toBe("");
    expect(serializeTabs(["a", NEW_SESSION_TAB], "a")).toBe("a,new");
    expect(serializeTabs(["b"], "a")).toBe("b");
  });

  test("parseView accepts sections and group keys only", () => {
    expect(parseView("inbox")).toBe("inbox");
    expect(parseView("nogroup")).toBe("nogroup");
    expect(parseView("shared/northwind/pricing/")).toBe("shared/northwind/pricing/");
    expect(parseView("shared/northwind")).toBeNull();
    expect(parseView("")).toBeNull();
  });

  test("openTab replaces the focused tab, or adds a new tab after it", () => {
    expect(openTab(["a", "b"], "a", "c")).toEqual(["c", "b"]);
    expect(openTab(["a", "b"], "a", "c", { newTab: true })).toEqual(["a", "c", "b"]);
    expect(openTab(["a", "b"], "a", "b")).toEqual(["a", "b"]);
    expect(openTab(["a"], "x", "c")).toEqual(["a", "c"]);
  });

  test("closeTab moves the focus right, then left, and leaves a New session tab", () => {
    expect(closeTab(["a", "b", "c"], "b", "b")).toEqual({ tabs: ["a", "c"], focused: "c" });
    expect(closeTab(["a", "b"], "b", "b")).toEqual({ tabs: ["a"], focused: "a" });
    expect(closeTab(["a", "b"], "a", "b")).toEqual({ tabs: ["a"], focused: "a" });
    expect(closeTab(["a"], "a", "a")).toEqual({
      tabs: [NEW_SESSION_TAB],
      focused: NEW_SESSION_TAB,
    });
    expect(closeTab(["a"], "a", "zz")).toEqual({ tabs: ["a"], focused: "a" });
  });

  test("tabPath maps the New session tab to /sessions", () => {
    expect(tabPath(NEW_SESSION_TAB)).toBe("/sessions");
    expect(tabPath("abc")).toBe("/sessions/abc");
  });

  test("the group tab owns /sessions while ?view= is set", () => {
    expect(tabPath(GROUP_TAB)).toBe("/sessions");
    expect(tabPath(NEW_SESSION_TAB, true)).toBe("/sessions/new");
    expect(focusedTab(undefined, "inbox")).toBe(GROUP_TAB);
    expect(focusedTab(undefined, null)).toBe(NEW_SESSION_TAB);
    expect(focusedTab(NEW_SESSION_TAB, "inbox")).toBe(NEW_SESSION_TAB);
    expect(focusedTab("abc", "inbox")).toBe("abc");
  });

  test("a session opened from the group tab or the New session tab opens next to it", () => {
    expect(openTab(["a", GROUP_TAB], GROUP_TAB, "c")).toEqual(["a", GROUP_TAB, "c"]);
    expect(openTab([NEW_SESSION_TAB, "a"], NEW_SESSION_TAB, "c")).toEqual([
      NEW_SESSION_TAB,
      "c",
      "a",
    ]);
  });

  test("Send turns the New session tab into its session", () => {
    expect(replaceTab(["a", NEW_SESSION_TAB, "b"], NEW_SESSION_TAB, "c")).toEqual(["a", "c", "b"]);
    expect(replaceTab(["a"], NEW_SESSION_TAB, "c")).toEqual(["a", "c"]);
  });

  test("the URL keeps the split session out of the main tabs", () => {
    const at = (tabs: string | null, focused: string, split: string | null, view = null) =>
      urlTabs(tabs, { focused, view, split });
    expect(at("a,b", "a", "b")).toEqual({ tabs: ["a"], split: "b" });
    expect(at("a,b", "a", "a")).toEqual({ tabs: ["a", "b"], split: null });
    expect(at(`a,${GROUP_TAB}`, "a", null)).toEqual({ tabs: ["a"], split: null });
    expect(urlTabs("a", { focused: "a", view: "inbox", split: GROUP_TAB })).toEqual({
      tabs: ["a"],
      split: null,
    });
    expect(urlTabs(`a,${GROUP_TAB}`, { focused: "a", view: "inbox", split: null })).toEqual({
      tabs: ["a", GROUP_TAB],
      split: null,
    });
  });

  test("the split can hold the New session tab, and only one New session shows", () => {
    const at = (tabs: string | null, focused: string, split: string | null) =>
      urlTabs(tabs, { focused, view: null, split });
    expect(at("a", "a", NEW_SESSION_TAB)).toEqual({ tabs: ["a"], split: NEW_SESSION_TAB });
    expect(at(`a,${NEW_SESSION_TAB}`, "a", NEW_SESSION_TAB)).toEqual({
      tabs: ["a"],
      split: NEW_SESSION_TAB,
    });
    expect(at(null, NEW_SESSION_TAB, NEW_SESSION_TAB)).toEqual({
      tabs: [NEW_SESSION_TAB],
      split: null,
    });
    expect(splitTo(["a"], "a", null, NEW_SESSION_TAB)).toEqual({
      tabs: ["a"],
      focused: "a",
      split: NEW_SESSION_TAB,
    });
    expect(splitTo(["a", NEW_SESSION_TAB], NEW_SESSION_TAB, null, NEW_SESSION_TAB)).toEqual({
      tabs: ["a"],
      focused: "a",
      split: NEW_SESSION_TAB,
    });
  });

  test("View all adds the group tab after the focused tab, and a second one reuses it", () => {
    expect(withGroupTab(["a", "b"], "a")).toEqual(["a", GROUP_TAB, "b"]);
    expect(withGroupTab(["a", GROUP_TAB, "b"], "b")).toEqual(["a", GROUP_TAB, "b"]);
  });

  test("closing the group tab clears ?view=, and New session goes back to /sessions", () => {
    const closed = closeUrlTab([GROUP_TAB, NEW_SESSION_TAB], NEW_SESSION_TAB, "inbox", GROUP_TAB);
    expect(closed).toEqual({ tabs: [NEW_SESSION_TAB], focused: NEW_SESSION_TAB, view: null });
    expect(tabPath(closed.focused, closed.view !== null)).toBe("/sessions");
    expect(closeUrlTab(["a", GROUP_TAB], "a", "inbox", "a").view).toBe("inbox");
  });

  test("splitTo moves a tab into the split, and needs a second tab first", () => {
    expect(splitTo(["a"], "a", null, "a")).toEqual({
      message: "Open a second session first. Then split.",
    });
    expect(splitTo(["a", "b"], "a", null, "b")).toEqual({ tabs: ["a"], focused: "a", split: "b" });
    expect(splitTo(["a", "b"], "a", null, "a")).toEqual({ tabs: ["b"], focused: "b", split: "a" });
    expect(splitTo(["a"], "a", null, "c")).toEqual({ tabs: ["a"], focused: "a", split: "c" });
    expect(splitTo(["a"], "a", "c", "c")).toEqual({ tabs: ["a"], focused: "a", split: "c" });
  });

  test("splitTo swaps the only tab with the split session", () => {
    expect(splitTo(["a"], "a", "x", "a")).toEqual({ tabs: ["x"], focused: "x", split: "a" });
  });

  test("splitTo puts the old split session back where the moved tab was", () => {
    expect(splitTo(["a", "b", "c"], "a", "x", "b")).toEqual({
      tabs: ["a", "x", "c"],
      focused: "a",
      split: "b",
    });
    expect(splitTo(["a", "b"], "a", "x", "c")).toEqual({
      tabs: ["a", "x", "b"],
      focused: "a",
      split: "c",
    });
  });

  test("closeSplit keeps the split session as the last tab only on request", () => {
    expect(closeSplit(["a"], "b", true)).toEqual(["a", "b"]);
    expect(closeSplit(["a"], "b", false)).toEqual(["a"]);
    expect(closeSplit(["a", "b"], "b", true)).toEqual(["a", "b"]);
    expect(isSessionTab("a")).toBe(true);
    expect(isSessionTab(GROUP_TAB)).toBe(false);
    expect(isSessionTab(NEW_SESSION_TAB)).toBe(false);
  });
});

describe("latestTask", () => {
  const task = (id: string, parentTaskId: string | null, lastUpdatedAt: string, status: string) =>
    ({ id, parentTaskId, lastUpdatedAt, status }) as unknown as AgentTask;

  test("takes the latest update", () => {
    const root = task("r", null, "2026-10-21T10:00:00.000Z", "completed");
    const chain = [root, task("c", "r", "2026-10-21T11:00:00.000Z", "failed")];
    expect(latestTask({ root, chain }).id).toBe("c");
  });

  test("on a tie, the parent wins over its child, as the server walks breadth first", () => {
    const root = task("r", null, "2026-10-21T11:39:15.176Z", "failed");
    const chain = [root, task("c", "r", "2026-10-21T11:39:15.176Z", "unassigned")];
    expect(latestTask({ root, chain }).status).toBe("failed");
    const deep = [
      task("r2", null, "2026-10-19T23:28:46.079Z", "pending"),
      task("a", "r2", "2026-10-20T03:02:16.113Z", "pending"),
      task("b", "a", "2026-10-21T11:39:15.142Z", "failed"),
      task("d", "b", "2026-10-21T11:39:15.142Z", "unassigned"),
    ];
    expect(latestTask({ root: deep[0], chain: deep }).status).toBe("failed");
  });

  test("on a tie between levels, the shallower task wins, also when the chain lists it later", () => {
    const root = task("r", null, "2026-10-21T09:00:00.000Z", "completed");
    const chain = [
      root,
      task("a", "r", "2026-10-21T09:10:00.000Z", "completed"),
      task("a1", "a", "2026-10-21T10:00:00.000Z", "failed"),
      task("b", "r", "2026-10-21T10:00:00.000Z", "in_progress"),
    ];
    expect(latestTask({ root, chain }).id).toBe("b");
  });
});
