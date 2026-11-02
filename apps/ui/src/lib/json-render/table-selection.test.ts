import { describe, expect, test } from "bun:test";
import {
  actionSlotFailed,
  applyRange,
  headerCheckState,
  hiddenSelectedCount,
  pruneSelection,
  sameSelection,
  selectionFromState,
  setRowSelected,
  toggleAllVisible,
} from "./table-selection";

describe("selectionFromState", () => {
  test("keeps string and number ids as strings, drops junk and duplicates", () => {
    expect(selectionFromState(["a", 7, "a", null, { x: 1 }, true])).toEqual(["a", "7"]);
  });

  test("anything but an array is an empty selection", () => {
    expect(selectionFromState(undefined)).toEqual([]);
    expect(selectionFromState("a")).toEqual([]);
    expect(selectionFromState({ 0: "a" })).toEqual([]);
  });
});

describe("headerCheckState", () => {
  const visible = ["a", "b", "c"];
  test("none, some and all visible rows selected", () => {
    expect(headerCheckState(visible, new Set())).toBe(false);
    expect(headerCheckState(visible, new Set(["b"]))).toBe("indeterminate");
    expect(headerCheckState(visible, new Set(["a", "b", "c"]))).toBe(true);
  });

  test("a selected row hidden by a filter does not count", () => {
    expect(headerCheckState(visible, new Set(["z"]))).toBe(false);
    expect(headerCheckState(visible, new Set(["a", "b", "c", "z"]))).toBe(true);
  });

  test("no visible rows is unchecked", () => {
    expect(headerCheckState([], new Set(["a"]))).toBe(false);
  });
});

describe("setRowSelected", () => {
  test("adds in click order and never duplicates", () => {
    expect(setRowSelected(["b"], "a", true)).toEqual(["b", "a"]);
    expect(setRowSelected(["b"], "b", true)).toEqual(["b"]);
  });

  test("removes only the row", () => {
    expect(setRowSelected(["a", "b"], "a", false)).toEqual(["b"]);
    expect(setRowSelected(["a"], "z", false)).toEqual(["a"]);
  });
});

describe("toggleAllVisible", () => {
  test("selects every visible row, keeping what was already picked", () => {
    expect(toggleAllVisible(["z", "b"], ["a", "b", "c"])).toEqual(["z", "b", "a", "c"]);
  });

  test("deselects the visible rows when all are on, leaving hidden selections", () => {
    expect(toggleAllVisible(["z", "a", "b", "c"], ["a", "b", "c"])).toEqual(["z"]);
  });

  test("an indeterminate header selects the rest", () => {
    expect(toggleAllVisible(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  test("nothing visible changes nothing", () => {
    expect(toggleAllVisible(["z"], [])).toEqual(["z"]);
  });
});

describe("applyRange", () => {
  const order = ["a", "b", "c", "d", "e"];

  test("selects the inclusive range in either direction", () => {
    expect(applyRange([], order, "b", "d", true)).toEqual(["b", "c", "d"]);
    expect(applyRange([], order, "d", "b", true)).toEqual(["b", "c", "d"]);
  });

  test("keeps existing picks and does not duplicate", () => {
    expect(applyRange(["c", "z"], order, "b", "d", true)).toEqual(["c", "z", "b", "d"]);
  });

  test("an unchecking shift-click clears the range", () => {
    expect(applyRange(["a", "b", "c", "d"], order, "b", "c", false)).toEqual(["a", "d"]);
  });

  test("uses the displayed (sorted) order, not the data order", () => {
    expect(applyRange([], ["c", "a", "b"], "c", "b", true)).toEqual(["c", "a", "b"]);
  });

  test("without a usable anchor it toggles one row", () => {
    expect(applyRange([], order, null, "c", true)).toEqual(["c"]);
    expect(applyRange([], order, "gone", "c", true)).toEqual(["c"]);
    expect(applyRange(["c"], order, null, "c", false)).toEqual([]);
  });
});

describe("pruneSelection / hiddenSelectedCount / sameSelection", () => {
  test("drops ids that left the data and keeps identity when nothing changed", () => {
    const selected = ["a", "b"];
    expect(pruneSelection(selected, new Set(["a"]))).toEqual(["a"]);
    expect(pruneSelection(selected, new Set(["a", "b", "c"]))).toBe(selected);
  });

  test("counts selected rows a filter hides", () => {
    expect(hiddenSelectedCount(["a", "z", "y"], ["a", "b"])).toBe(2);
  });

  test("order-sensitive equality", () => {
    expect(sameSelection(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameSelection(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameSelection(["a"], ["a", "b"])).toBe(false);
  });
});

describe("actionSlotFailed", () => {
  const slots: Record<string, unknown> = {
    "/actions/enqueue/status": "error",
    "/actions/askReview/status": "ok",
    "/refs/app2/actions/sync/status": "error",
  };
  const read = (path: string) => slots[path];

  test("an app.action whose slot ended in error failed", () => {
    expect(actionSlotFailed({ action: "app.action", params: { name: "enqueue" } }, read)).toBe(
      true,
    );
  });

  test("a clean, running or unknown slot did not", () => {
    expect(actionSlotFailed({ action: "app.action", params: { name: "askReview" } }, read)).toBe(
      false,
    );
    expect(actionSlotFailed({ action: "app.action", params: { name: "nope" } }, read)).toBe(false);
  });

  test("a borrowed action reads its /refs slot", () => {
    expect(
      actionSlotFailed({ action: "app.action", params: { name: "sync", $app: "app2" } }, read),
    ).toBe(true);
  });

  test("other steps never read as failed", () => {
    expect(actionSlotFailed({ action: "app.refresh" }, read)).toBe(false);
    expect(actionSlotFailed({ action: "app.mutate", params: { name: "enqueue" } }, read)).toBe(
      false,
    );
  });
});
