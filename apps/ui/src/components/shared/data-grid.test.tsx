import { describe, expect, mock, test } from "bun:test";
import type { ColDef } from "ag-grid-community";

// The test runner cannot resolve ui's `@/` alias (see list-pager.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/components/shared/list-pager", () => require("./list-pager"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/select", () => require("../ui/select"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { HIDE_WHEN_COMPACT, resolveCompactColumnDefs } = await import("./data-grid");

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

  test("never hides unmarked columns, however narrow", () => {
    const defs = resolveCompactColumnDefs(cols, 50);
    expect(defs.find((c) => c.field === "name")?.hide).toBeUndefined();
  });

  test("ignores an unmeasured (0px) grid", () => {
    expect(resolveCompactColumnDefs(cols, 0)).toBe(cols);
  });
});
