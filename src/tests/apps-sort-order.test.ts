import { describe, expect, spyOn, test } from "bun:test";
import type { AppRow } from "../apps/row-store";
import { sortRowsByColumn } from "../http/apps";

// Reference copy of the pre-change comparator (Date.parse per comparison).
function oldCompare(left: unknown, right: unknown, direction: "asc" | "desc", dateValues: boolean) {
  if (left === right) return 0;
  if (left === undefined || left === null) return 1;
  if (right === undefined || right === null) return -1;
  let result: number;
  if (dateValues && typeof left === "string" && typeof right === "string") {
    result = Date.parse(left) - Date.parse(right);
  } else if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else if (typeof left === "boolean" && typeof right === "boolean") {
    result = Number(left) - Number(right);
  } else {
    result = String(left).localeCompare(String(right));
  }
  return direction === "asc" ? result : -result;
}

function seededRows(n: number): AppRow[] {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pool: unknown[] = [
    null,
    undefined,
    "not a date",
    7,
    true,
    false,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00Z", // same instant, different string
  ];
  return Array.from({ length: n }, (_, i) => {
    const r = rand();
    const value =
      r < 0.5
        ? new Date(1_700_000_000_000 + Math.floor(rand() * 40) * 3_600_000).toISOString()
        : pool[Math.floor(rand() * pool.length)];
    const row: AppRow = { id: String(i) };
    if (value !== undefined) row.at = value as never;
    return row;
  });
}

describe("sortRowsByColumn", () => {
  for (const dir of ["asc", "desc"] as const) {
    for (const dateValues of [true, false]) {
      test(`matches the old comparator order (${dir}, dateValues=${dateValues})`, () => {
        const rows = seededRows(500);
        const expected = [...rows].sort((a, b) => oldCompare(a.at, b.at, dir, dateValues));
        const actual = sortRowsByColumn(rows, "at", dir, dateValues);
        expect(actual.map((r) => r.id)).toEqual(expected.map((r) => r.id));
      });
    }
  }

  test("does not mutate its input and keeps ties stable", () => {
    const rows: AppRow[] = [
      { id: "a", at: "2026-01-01T00:00:00Z" },
      { id: "b", at: "2026-01-01T00:00:00.000Z" },
      { id: "c", at: "2025-01-01T00:00:00Z" },
    ];
    const sorted = sortRowsByColumn(rows, "at", "asc", true);
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("parses each date once, not per comparison", () => {
    const rows = seededRows(5000).map((r, i) => ({
      id: r.id,
      at: new Date(1_700_000_000_000 + ((i * 7919) % 5000) * 60_000).toISOString(),
    }));
    const spy = spyOn(Date, "parse");
    try {
      sortRowsByColumn(rows, "at", "desc", true);
      expect(spy.mock.calls.length).toBe(rows.length);
    } finally {
      spy.mockRestore();
    }
  });
});
