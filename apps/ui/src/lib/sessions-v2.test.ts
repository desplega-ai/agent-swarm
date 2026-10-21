import { describe, expect, test } from "bun:test";
import {
  closeTab,
  NEW_SESSION_TAB,
  openTab,
  parseTabs,
  parseView,
  serializeTabs,
  tabPath,
  tabsWithFocus,
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
});
