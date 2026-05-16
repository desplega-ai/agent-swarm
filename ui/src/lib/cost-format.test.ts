import { describe, expect, test } from "bun:test";
import { formatCost } from "./cost-format";

describe("formatCost", () => {
  describe("auto precision (default)", () => {
    test("sub-cent shows the '<$0.01' qualitative bucket", () => {
      expect(formatCost(0.0001)).toBe("<$0.01");
      expect(formatCost(0.009)).toBe("<$0.01");
    });

    test("under $1 uses 4dp", () => {
      expect(formatCost(0.0125)).toBe("$0.0125");
      expect(formatCost(0.5)).toBe("$0.5000");
    });

    test("at or above $1 uses 2dp", () => {
      expect(formatCost(1)).toBe("$1.00");
      expect(formatCost(42.5)).toBe("$42.50");
      expect(formatCost(1234)).toBe("$1234.00");
    });
  });

  describe("compact precision", () => {
    test("K / M bucketed", () => {
      expect(formatCost(1500, { precision: "compact" })).toBe("$1.5K");
      expect(formatCost(2_500_000, { precision: "compact" })).toBe("$2.5M");
    });

    test("under 1K uses tiered toFixed", () => {
      expect(formatCost(123, { precision: "compact" })).toBe("$123");
      expect(formatCost(12.5, { precision: "compact" })).toBe("$12.5");
      expect(formatCost(2.5, { precision: "compact" })).toBe("$2.50");
      expect(formatCost(0.005, { precision: "compact" })).toBe("$0.005");
    });
  });

  describe("precise precision", () => {
    test("6dp for pricing-rate cells", () => {
      expect(formatCost(0.0000025, { precision: "precise" })).toBe("$0.000003");
      expect(formatCost(15, { precision: "precise" })).toBe("$15.000000");
    });
  });

  describe("explicit numeric precision", () => {
    test("forwards to toFixed(n)", () => {
      expect(formatCost(1.23456, { precision: 3 })).toBe("$1.235");
    });
  });

  describe("null / NaN / negative / zero", () => {
    test("placeholder for null + undefined + NaN + negative", () => {
      expect(formatCost(null)).toBe("—");
      expect(formatCost(undefined)).toBe("—");
      expect(formatCost(NaN)).toBe("—");
      expect(formatCost(-1)).toBe("—");
    });

    test("zero renders as $0 (visually distinct from missing data)", () => {
      expect(formatCost(0)).toBe("$0");
    });

    test("custom placeholder", () => {
      expect(formatCost(null, { placeholder: "n/a" })).toBe("n/a");
    });
  });
});
