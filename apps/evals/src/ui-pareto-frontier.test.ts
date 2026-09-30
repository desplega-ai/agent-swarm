import { describe, expect, test } from "bun:test";
import { paretoFrontier } from "../ui/src/lib/pareto.ts";

interface P {
  id: string;
  x: number;
  y: number;
}

const ids = (items: P[]) =>
  paretoFrontier(
    items,
    (p) => p.x,
    (p) => p.y,
  ).map((p) => p.id);

describe("paretoFrontier (lower x, higher y is better)", () => {
  test("keeps the non-dominated points, left to right", () => {
    const pts: P[] = [
      { id: "pricey-best", x: 10, y: 0.9 },
      { id: "dominated", x: 5, y: 0.4 },
      { id: "cheap", x: 1, y: 0.5 },
      { id: "mid", x: 4, y: 0.7 },
      { id: "worse-and-pricier", x: 12, y: 0.8 },
    ];
    expect(ids(pts)).toEqual(["cheap", "mid", "pricey-best"]);
  });

  test("same x keeps only the higher y; a full tie keeps the first", () => {
    const pts: P[] = [
      { id: "low", x: 2, y: 0.3 },
      { id: "high", x: 2, y: 0.6 },
      { id: "tie-a", x: 3, y: 0.8 },
      { id: "tie-b", x: 3, y: 0.8 },
    ];
    expect(ids(pts)).toEqual(["high", "tie-a"]);
  });

  test("one point that beats everything is the whole frontier", () => {
    const pts: P[] = [
      { id: "best", x: 1, y: 1 },
      { id: "a", x: 2, y: 0.5 },
      { id: "b", x: 3, y: 0.9 },
    ];
    expect(ids(pts)).toEqual(["best"]);
  });

  test("skips non-finite coordinates and does not mutate the input", () => {
    const pts: P[] = [
      { id: "nan", x: Number.NaN, y: 1 },
      { id: "b", x: 2, y: 0.9 },
      { id: "a", x: 1, y: 0.5 },
    ];
    expect(ids(pts)).toEqual(["a", "b"]);
    expect(pts.map((p) => p.id)).toEqual(["nan", "b", "a"]);
    expect(ids([])).toEqual([]);
  });
});
