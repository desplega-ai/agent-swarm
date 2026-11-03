import { describe, expect, mock, test } from "bun:test";
import type { ColDef } from "ag-grid-community";

// The test runner cannot resolve ui's `@/` alias (see list-pager.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/components/shared/list-pager", () => require("./list-pager"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/select", () => require("../ui/select"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { HIDE_WHEN_COMPACT, resolveCompactColumnDefs, summarizeGridColumns } = await import(
  "./data-grid"
);

const cols: ColDef[] = [
  { field: "name", flex: 1, minWidth: 200 },
  { field: "type", width: 110, context: HIDE_WHEN_COMPACT },
  { field: "model", width: 150, context: HIDE_WHEN_COMPACT },
  { field: "updated", width: 150, context: HIDE_WHEN_COMPACT },
];

const hiddenFields = (defs: ColDef[]) => defs.filter((c) => c.hide).map((c) => c.field);

describe("resolveCompactColumnDefs", () => {
  test("keeps every column when the grid is wide enough", () => {
    expect(resolveCompactColumnDefs(cols, 610)).toBe(cols);
  });

  test("hides marked columns last-first until the rest fit", () => {
    expect(hiddenFields(resolveCompactColumnDefs(cols, 464))).toEqual(["updated"]);
    expect(hiddenFields(resolveCompactColumnDefs(cols, 400))).toEqual(["model", "updated"]);
    expect(hiddenFields(resolveCompactColumnDefs(cols, 300))).toEqual(["type", "model", "updated"]);
  });

  test("hides lower priorities first while preserving visual order", () => {
    const agents: ColDef[] = [
      { field: "name", width: 250, minWidth: 180 },
      { field: "role", width: 150, context: { ...HIDE_WHEN_COMPACT, compactHidePriority: 1 } },
      { field: "harness", width: 200, context: { ...HIDE_WHEN_COMPACT, compactHidePriority: 3 } },
      { field: "status", width: 120 },
      { field: "capacity", width: 110, context: { ...HIDE_WHEN_COMPACT, compactHidePriority: 2 } },
      {
        field: "model",
        width: 320,
        minWidth: 260,
        context: { ...HIDE_WHEN_COMPACT, compactHidePriority: 4 },
      },
      { field: "updated", flex: 1, minWidth: 150 },
    ];
    expect(resolveCompactColumnDefs(agents, 1300)).toBe(agents);
    expect(hiddenFields(resolveCompactColumnDefs(agents, 1206))).toEqual(["role"]);
    expect(hiddenFields(resolveCompactColumnDefs(agents, 1149))).toEqual(["role", "capacity"]);
    expect(hiddenFields(resolveCompactColumnDefs(agents, 1039))).toEqual([
      "role",
      "harness",
      "capacity",
    ]);
    expect(hiddenFields(resolveCompactColumnDefs(agents, 839))).toEqual([
      "role",
      "harness",
      "capacity",
      "model",
    ]);
    const narrow = resolveCompactColumnDefs(agents, 480);
    expect(narrow.map((col) => col.field)).toEqual(agents.map((col) => col.field));
    expect(
      narrow.reduce((sum, col) => sum + (col.hide ? 0 : (col.minWidth ?? 80)), 0),
    ).toBeLessThanOrEqual(480);
    expect(agents.every((col) => !col.hide)).toBe(true);
  });

  test("equal priorities retain last-first hiding", () => {
    const defs = cols.map((col) => ({
      ...col,
      context: { ...col.context, compactHidePriority: 1 },
    }));
    expect(hiddenFields(resolveCompactColumnDefs(defs, 464))).toEqual(["updated"]);
    expect(hiddenFields(resolveCompactColumnDefs(defs, 400))).toEqual(["model", "updated"]);
  });

  test("never hides unmarked columns, however narrow", () => {
    const defs = resolveCompactColumnDefs(cols, 50);
    expect(defs.find((c) => c.field === "name")?.hide).toBeUndefined();
  });

  test("ignores an unmeasured (0px) grid", () => {
    expect(resolveCompactColumnDefs(cols, 0)).toBe(cols);
  });
});

describe("column overrides", () => {
  const overrides = (show: string[], hide: string[] = []) => ({
    show: new Set(show),
    hide: new Set(hide),
  });

  test("a force-shown column survives a narrow grid", () => {
    const defs = resolveCompactColumnDefs(cols, 300, overrides(["updated"]));
    expect(hiddenFields(defs)).toEqual(["type", "model"]);
    expect(defs.find((c) => c.field === "updated")?.hide).toBeUndefined();
  });

  test("forcing a column never evicts another; the grid scrolls instead", () => {
    expect(hiddenFields(resolveCompactColumnDefs(cols, 464))).toEqual(["updated"]);
    expect(hiddenFields(resolveCompactColumnDefs(cols, 464, overrides(["updated"])))).toEqual([]);
  });

  test("a user-hidden column stays hidden on a wide grid and frees its width", () => {
    expect(hiddenFields(resolveCompactColumnDefs(cols, 610, overrides([], ["type"])))).toEqual([
      "type",
    ]);
    // At 500 "updated" would auto-hide, but without "type" the rest fit.
    expect(hiddenFields(resolveCompactColumnDefs(cols, 500))).toEqual(["updated"]);
    expect(hiddenFields(resolveCompactColumnDefs(cols, 500, overrides([], ["type"])))).toEqual([
      "type",
    ]);
  });

  test("overrides never touch unmarked columns", () => {
    const defs = resolveCompactColumnDefs(cols, 610, overrides([], ["name"]));
    expect(defs).toBe(cols);
  });
});

describe("summarizeGridColumns", () => {
  test("counts the columns hidden to fit and lists them unchecked", () => {
    const withHelpers: ColDef[] = [
      ...cols,
      { colId: "actions", headerName: "", width: 60 },
      { field: "secret", hide: true, context: HIDE_WHEN_COMPACT },
    ];
    const summary = summarizeGridColumns(withHelpers, resolveCompactColumnDefs(withHelpers, 460));
    expect(summary.hiddenCount).toBe(2);
    expect(summary.entries).toEqual([
      { id: "name", label: "name", visible: true, toggleable: false },
      { id: "type", label: "type", visible: true, toggleable: true },
      { id: "model", label: "model", visible: false, toggleable: true },
      { id: "updated", label: "updated", visible: false, toggleable: true },
    ]);
  });

  test("reports zero hidden when every column fits", () => {
    expect(summarizeGridColumns(cols, resolveCompactColumnDefs(cols, 610)).hiddenCount).toBe(0);
  });
});
