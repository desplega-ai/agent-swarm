import { describe, expect, test } from "bun:test";
import { mergeLcov } from "../../scripts/run-root-coverage";

describe("mergeLcov", () => {
  test("disjoint function hits remain a conservative lower bound without FN/FNDA identities", () => {
    // a.test.ts calls a(); b.test.ts calls b() in the same two-function module.
    const report = "SF:src/example.ts\nFNF:2\nFNH:1\nend_of_record\n";
    const merged = mergeLcov([report, report]);

    expect(merged).toContain("FNF:2\nFNH:1\n");
  });

  test("DA hits sum across reports and LH counts lines hit in any report", () => {
    const merged = mergeLcov([
      "SF:src/example.ts\nDA:1,2\nDA:2,0\nDA:3,0\nend_of_record\n",
      "SF:src/example.ts\nDA:1,3\nDA:2,1\nDA:3,0\nend_of_record\n",
    ]);

    expect(merged).toBe(
      "TN:\nSF:src/example.ts\nFNF:0\nFNH:0\nDA:1,5\nDA:2,1\nDA:3,0\nLF:3\nLH:2\nend_of_record\n",
    );
  });

  test("FNH never exceeds FNF when merging function totals", () => {
    const reports = [
      "SF:src/example.ts\nFNF:2\nFNH:2\nend_of_record\n",
      "SF:src/example.ts\nFNF:3\nFNH:1\nend_of_record\n",
    ];
    for (const inputs of [reports, reports.toReversed(), [...reports, ...reports]]) {
      const merged = mergeLcov(inputs);
      const found = Number(merged.match(/^FNF:(\d+)$/m)![1]);
      const hit = Number(merged.match(/^FNH:(\d+)$/m)![1]);

      expect(found).toBe(3);
      expect(hit).toBe(2);
      expect(hit).toBeLessThanOrEqual(found);
    }
  });
});
