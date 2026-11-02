import { describe, expect, test } from "bun:test";
import {
  activeFilterCount,
  applyColumnFilters,
  clearFilter,
  columnFilterMode,
  type FilterColumn,
  facetOptions,
  filterKey,
  filterPills,
  filtersFromState,
  isMutedValue,
  narrowByColumnFilters,
  setFilterText,
  toggleFilterValue,
} from "./table-filters";

const columns: FilterColumn[] = [
  { key: "title", label: "Title" },
  { key: "ci", label: "CI on head", kind: "badge", muted: ["none"] },
  { key: "draft", label: "Draft", kind: "boolean" },
  { key: "n", kind: "number" },
  { key: "pr", kind: undefined, format: "{{repo}}#{{n}}" },
];
const byKey = new Map(columns.map((c) => [c.key, c]));
const read = (row: Record<string, unknown>, column: FilterColumn) =>
  column.format ? `${row.repo}#${row.n}` : row[column.key];

const rows = [
  { title: "fix: a", ci: "green", draft: false, n: 1, repo: "x" },
  { title: "feat: b", ci: "green", draft: true, n: 2, repo: "x" },
  { title: "fix: c", ci: "red", draft: false, n: 3, repo: "y" },
  { title: "chore: d", ci: "none", draft: false, n: 4, repo: "y" },
  { title: "docs: e", ci: null, draft: "true", n: 5, repo: "y" },
];

describe("columnFilterMode", () => {
  test("filterable picks by kind; numbers and format columns get none", () => {
    expect(columnFilterMode({ key: "a", kind: "badge" }, true)).toBe("values");
    expect(columnFilterMode({ key: "a", kind: "status" }, true)).toBe("values");
    expect(columnFilterMode({ key: "a", kind: "enum" }, true)).toBe("values");
    expect(columnFilterMode({ key: "a", kind: "boolean" }, true)).toBe("values");
    expect(columnFilterMode({ key: "a", kind: "user" }, true)).toBe("values");
    expect(columnFilterMode({ key: "a" }, true)).toBe("text");
    expect(columnFilterMode({ key: "a", kind: "string" }, true)).toBe("text");
    expect(columnFilterMode({ key: "a", kind: "number" }, true)).toBeNull();
    expect(columnFilterMode({ key: "a", kind: "relative" }, true)).toBeNull();
    expect(columnFilterMode({ key: "a", kind: "link" }, true)).toBeNull();
    expect(columnFilterMode({ key: "a", format: "{{x}}" }, true)).toBeNull();
  });

  test("nothing filters without filterable or an explicit column filter", () => {
    expect(columnFilterMode({ key: "a", kind: "badge" }, false)).toBeNull();
    expect(columnFilterMode({ key: "a", kind: "badge", filter: "text" }, false)).toBe("text");
    expect(columnFilterMode({ key: "a", format: "{{x}}", filter: "text" }, false)).toBe("text");
  });

  test("filter:false opts one column out", () => {
    expect(columnFilterMode({ key: "a", kind: "badge", filter: false }, true)).toBeNull();
  });
});

describe("filterKey and muted values", () => {
  test("normalises booleans, numbers and nothing", () => {
    expect(filterKey({ key: "d", kind: "boolean" }, "true")).toBe("true");
    expect(filterKey({ key: "d", kind: "boolean" }, 0)).toBe("false");
    expect(filterKey({ key: "n" }, 7)).toBe("7");
    expect(filterKey({ key: "n" }, null)).toBe("");
    expect(filterKey({ key: "n" }, undefined)).toBe("");
  });

  test("muted matches case-insensitively and never matches an empty cell", () => {
    const column = { muted: ["none", "No"] };
    expect(isMutedValue(column, "NONE")).toBe(true);
    expect(isMutedValue(column, "no")).toBe(true);
    expect(isMutedValue(column, "no MQ")).toBe(false);
    expect(isMutedValue(column, "")).toBe(false);
    expect(isMutedValue(column, null)).toBe(false);
    expect(isMutedValue({}, "none")).toBe(false);
  });
});

describe("filter state", () => {
  const modes = new Map([
    ["ci", "values" as const],
    ["title", "text" as const],
  ]);

  test("filtersFromState drops unknown columns, junk and empty entries", () => {
    expect(
      filtersFromState(
        {
          ci: ["green", "green", 7, { x: 1 }, "red"],
          title: "  ",
          ghost: ["a"],
        },
        modes,
      ),
    ).toEqual({ ci: ["green", "7", "red"] });
    expect(filtersFromState({ title: "fix" }, modes)).toEqual({ title: "fix" });
    expect(filtersFromState({ ci: "green" }, modes)).toEqual({ ci: ["green"] });
    expect(filtersFromState({ ci: [] }, modes)).toEqual({});
    expect(filtersFromState(undefined, modes)).toEqual({});
    expect(filtersFromState([], modes)).toEqual({});
  });

  test("toggle adds, removes and drops the entry when it empties", () => {
    let filters = toggleFilterValue({}, "ci", "green", true);
    filters = toggleFilterValue(filters, "ci", "red", true);
    filters = toggleFilterValue(filters, "ci", "red", true);
    expect(filters).toEqual({ ci: ["green", "red"] });
    filters = toggleFilterValue(filters, "ci", "green", false);
    expect(filters).toEqual({ ci: ["red"] });
    expect(toggleFilterValue(filters, "ci", "red", false)).toEqual({});
  });

  test("setFilterText, clearFilter and activeFilterCount", () => {
    expect(setFilterText({}, "title", "fix")).toEqual({ title: "fix" });
    expect(setFilterText({ title: "fix" }, "title", "   ")).toEqual({});
    const both = { title: "fix", ci: ["red"] };
    expect(activeFilterCount(both)).toBe(2);
    expect(clearFilter(both, "title")).toEqual({ ci: ["red"] });
    expect(both).toEqual({ title: "fix", ci: ["red"] });
  });
});

describe("matching", () => {
  test("a values filter is OR within the column and AND across columns", () => {
    const hit = (filters: Parameters<typeof applyColumnFilters>[1]) =>
      applyColumnFilters(rows, filters, byKey, read).map((r) => r.title);
    expect(hit({ ci: ["green", "red"] })).toEqual(["fix: a", "feat: b", "fix: c"]);
    expect(hit({ ci: ["green"], draft: ["false"] })).toEqual(["fix: a"]);
    expect(hit({})).toHaveLength(5);
  });

  test("an empty cell is its own value", () => {
    const hit = applyColumnFilters(rows, { ci: [""] }, byKey, read);
    expect(hit.map((r) => r.title)).toEqual(["docs: e"]);
  });

  test("boolean cells match however the data spells them", () => {
    const hit = applyColumnFilters(rows, { draft: ["true"] }, byKey, read);
    expect(hit.map((r) => r.title)).toEqual(["feat: b", "docs: e"]);
  });

  test("a text filter is a case-insensitive contains", () => {
    expect(applyColumnFilters(rows, { title: "FIX" }, byKey, read).map((r) => r.title)).toEqual([
      "fix: a",
      "fix: c",
    ]);
  });

  test("a format column filters on its composed text", () => {
    expect(applyColumnFilters(rows, { pr: "y#" }, byKey, read)).toHaveLength(3);
  });

  test("a filter on a column that no longer exists is ignored", () => {
    expect(applyColumnFilters(rows, { gone: ["x"] }, byKey, read)).toHaveLength(5);
  });
});

describe("facets", () => {
  test("distinct values with counts, sorted by label, empty cell included", () => {
    const options = facetOptions(rows, byKey.get("ci")!, read);
    expect(options).toEqual([
      { value: "", label: "(empty)", count: 1 },
      { value: "green", label: "green", count: 2 },
      { value: "none", label: "none", count: 1 },
      { value: "red", label: "red", count: 1 },
    ]);
  });

  test("boolean columns read Yes and No", () => {
    const options = facetOptions(rows, byKey.get("draft")!, read);
    expect(options.map((o) => [o.value, o.label, o.count])).toEqual([
      ["false", "No", 3],
      ["true", "Yes", 2],
    ]);
  });

  test("a selected value the rows no longer have stays in the list with a zero", () => {
    const options = facetOptions(rows, byKey.get("ci")!, read, ["amber"]);
    expect(options.find((o) => o.value === "amber")).toEqual({
      value: "amber",
      label: "amber",
      count: 0,
    });
  });

  test("numbers sort naturally", () => {
    const data = [{ v: "10" }, { v: "9" }, { v: "100" }];
    expect(
      facetOptions(data, { key: "v" }, (row, column) => row[column.key]).map((o) => o.value),
    ).toEqual(["9", "10", "100"]);
  });

  test("a column's counts ignore its own filter but honour the others", () => {
    const modes = new Map([
      ["ci", "values" as const],
      ["draft", "values" as const],
    ]);
    const { rows: out, facets } = narrowByColumnFilters(
      rows,
      { ci: ["red"], draft: ["false"] },
      byKey,
      modes,
      read,
    );
    expect(out.map((r) => r.title)).toEqual(["fix: c"]);
    // ci counts over draft=false rows only (a, c, d), not over ci=red. The list keeps every value.
    expect(facets.ci!.map((o) => [o.value, o.count])).toEqual([
      ["", 0],
      ["green", 1],
      ["none", 1],
      ["red", 1],
    ]);
    // draft counts over ci=red rows only.
    expect(facets.draft!.map((o) => [o.value, o.count])).toEqual([
      ["false", 1],
      ["true", 0],
    ]);
  });
});

describe("pills", () => {
  test("one per active filter in column order, folding long lists", () => {
    const pills = filterPills({ ci: ["green", "red", "none"], title: " fix " }, columns);
    expect(pills).toEqual([
      { key: "title", column: "Title", text: 'contains "fix"' },
      { key: "ci", column: "CI on head", text: "green, red +1" },
    ]);
  });

  test("boolean values read Yes / No and an empty value reads (empty)", () => {
    expect(filterPills({ draft: ["true"], ci: [""] }, columns)).toEqual([
      { key: "ci", column: "CI on head", text: "(empty)" },
      { key: "draft", column: "Draft", text: "Yes" },
    ]);
  });
});
