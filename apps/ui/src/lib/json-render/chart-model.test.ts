import { describe, expect, test } from "bun:test";
import {
  chartValueFormatter,
  seriesColor,
  sparklineValues,
  timeTickFormatter,
  toChartPoints,
  toTimestamp,
} from "./chart-model";

describe("toChartPoints", () => {
  const rows = [
    { day: "2026-11-03", a: 3, b: "4" },
    { day: "nope", a: 1, b: 1 },
    { day: "2026-11-01", a: "x", b: null },
  ];

  test("category axis keeps row order and turns bad numbers into gaps", () => {
    expect(toChartPoints(rows, "day", "category", ["a", "b"])).toEqual([
      { __x: "2026-11-03", a: 3, b: 4 },
      { __x: "nope", a: 1, b: 1 },
      { __x: "2026-11-01", a: null, b: null },
    ]);
  });

  test("time axis drops unparseable x values and sorts by time", () => {
    const points = toChartPoints(rows, "day", "time", ["a"]);
    expect(points.map((p) => p.__x)).toEqual([Date.parse("2026-11-01"), Date.parse("2026-11-03")]);
    expect(points.map((p) => p.a)).toEqual([null, 3]);
  });

  test("epoch ms parses as time; booleans and blanks do not", () => {
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toTimestamp("")).toBeNull();
    expect(toTimestamp(true)).toBeNull();
  });
});

describe("chartValueFormatter", () => {
  test("percent reads ratios; currency uses the ISO code", () => {
    expect(chartValueFormatter("percent")(0.425)).toContain("42.5");
    expect(chartValueFormatter("currency", "EUR")(12)).toContain("12");
    expect(chartValueFormatter("currency", "EUR")(12)).toMatch(/€|EUR/);
    expect(chartValueFormatter("number", "USD", true)(12_000)).toMatch(/12\s?K/i);
  });
});

describe("seriesColor", () => {
  test("explicit color wins; otherwise the palette cycles", () => {
    expect(seriesColor("error", 0)).toBe("var(--color-status-error)");
    expect(seriesColor(undefined, 1)).toBe("var(--color-chart-2)");
    expect(seriesColor(undefined, 0)).toBe("var(--color-primary)");
    expect(seriesColor(undefined, 5)).toBe("var(--color-primary)");
  });
});

describe("sparklineValues", () => {
  test("numbers pass through with gaps; rows read through the key", () => {
    expect(sparklineValues([1, null, 3], undefined)).toEqual([1, null, 3]);
    expect(sparklineValues([{ v: 1 }, { v: "2" }], "v")).toEqual([1, 2]);
  });

  test("fewer than two numbers, rows without a key, or a non-array draw nothing", () => {
    expect(sparklineValues([1, null], undefined)).toEqual([]);
    expect(sparklineValues([{ v: 1 }, { v: 2 }], undefined)).toEqual([]);
    expect(sparklineValues("1,2", undefined)).toEqual([]);
  });
});

describe("timeTickFormatter", () => {
  // Local-time constructors keep these independent of the runner's TZ.
  const at = (day: number, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
  const ticks = (xs: number[]) => {
    const format = timeTickFormatter(xs.map((x) => ({ __x: x })));
    return xs.map(format);
  };

  test("two consecutive daily points get distinct date labels", () => {
    expect(ticks([at(3), at(4)])).toEqual(["Nov 3", "Nov 4"]);
  });

  test("points crossing midnight within a day carry the date on every tick", () => {
    expect(ticks([at(3, 22), at(4, 0), at(4, 2, 30)])).toEqual([
      "Nov 3 22:00",
      "Nov 4",
      "Nov 4 02:30",
    ]);
  });

  test("points within one day show the clock only", () => {
    expect(ticks([at(3, 9), at(3, 17, 45)])).toEqual(["09:00", "17:45"]);
  });
});
