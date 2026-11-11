import { describe, expect, test } from "bun:test";
import {
  diffCoverage,
  inScope,
  lineRanges,
  MARKER,
  parseDiff,
  parseExemptions,
  parseLcov,
  renderComment,
} from "../../scripts/e2e/diff-coverage";

const LCOV_BOOT = `TN:
SF:src/http/a.ts
DA:1,1
DA:2,0
DA:3,0
DA:5,0
LF:4
LH:1
end_of_record
`;
const LCOV_RESTART = `SF:src/http/a.ts
DA:2,0
DA:3,4
end_of_record
`;

const DIFF = `diff --git a/src/http/a.ts b/src/http/a.ts
--- a/src/http/a.ts
+++ b/src/http/a.ts
@@ -1,0 +2,3 @@
+a
+b
+// c
@@ -9 +11 @@
+d
diff --git a/src/be/new.ts b/src/be/new.ts
new file mode 100644
--- /dev/null
+++ b/src/be/new.ts
@@ -0,0 +1,4 @@
+// header
+export function f() {
+
+  return 1;
diff --git a/src/be/types-only.ts b/src/be/types-only.ts
--- /dev/null
+++ b/src/be/types-only.ts
@@ -0,0 +1 @@
+export type T = { a: number };
diff --git a/src/commands/worker.ts b/src/commands/worker.ts
--- a/src/commands/worker.ts
+++ b/src/commands/worker.ts
@@ -3 +3 @@
+x
diff --git a/src/http/gone.ts b/src/http/gone.ts
--- a/src/http/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
`;

const SOURCES: Record<string, string> = {
  "src/be/new.ts": "// header\nexport function f() {\n\n  return 1;\n}\n",
  "src/be/types-only.ts": "export type T = { a: number };\n",
};

describe("e2e diff coverage", () => {
  test("lcov from several API processes unions: any hit covers the line", () => {
    const hits = parseLcov(LCOV_RESTART, parseLcov(LCOV_BOOT));
    expect([...hits.get("src/http/a.ts")!]).toEqual([
      [1, 1],
      [2, 0],
      [3, 4],
      [5, 0],
    ]);
  });

  test("diff gives added new-side lines; deleted files drop out", () => {
    const added = parseDiff(DIFF);
    expect(added.get("src/http/a.ts")).toEqual([2, 3, 4, 11]);
    expect(added.get("src/be/new.ts")).toEqual([1, 2, 3, 4]);
    expect(added.has("src/http/gone.ts")).toBe(false);
  });

  test("scope: API source only, minus worker code, tests and exemptions", () => {
    const exempt = ["src/scripts-runtime/eval-harness.ts", "src/legacy/"];
    expect(inScope("src/http/a.ts", exempt)).toBe(true);
    for (const path of [
      "src/commands/worker.ts",
      "src/providers/x.ts",
      "src/claude.ts",
      "src/tests/a.test.ts",
      "src/http/a.test.ts",
      "src/types.d.ts",
      "src/be/migrations/001.sql",
      "apps/ui/src/a.ts",
      "packages/x/a.ts",
      "scripts/e2e/run.ts",
      "src/scripts-runtime/eval-harness.ts",
      "src/legacy/a.ts",
    ]) {
      expect(inScope(path, exempt)).toBe(false);
    }
  });

  test("only executable lines count; an unloaded file counts its code lines in full", () => {
    const report = diffCoverage(
      parseDiff(DIFF),
      parseLcov(LCOV_RESTART, parseLcov(LCOV_BOOT)),
      [],
      (path) => SOURCES[path]!,
    );
    expect(report.files).toEqual([
      { path: "src/be/new.ts", changed: 2, covered: 0, uncovered: [2, 4], loaded: false },
      { path: "src/http/a.ts", changed: 2, covered: 1, uncovered: [2], loaded: true },
    ]);
    expect(report).toMatchObject({ changed: 4, covered: 1 });
  });

  test("exemptions need a reason", () => {
    expect(parseExemptions("# c\n\nsrc/a.ts  why\nsrc/b/ because\n")).toEqual([
      "src/a.ts",
      "src/b/",
    ]);
    expect(() => parseExemptions("src/a.ts\n")).toThrow(/line 1/);
  });

  test("ranges and comment shapes", () => {
    expect(lineRanges([3, 4, 5, 9, 11, 12])).toBe("3-5, 9, 11-12");
    const body = renderComment(
      {
        changed: 4,
        covered: 1,
        files: [
          { path: "src/be/new.ts", changed: 2, covered: 0, uncovered: [2, 4], loaded: false },
        ],
      },
      6,
    );
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("**1 of 4 changed API lines run in an e2e scenario (25.0%).**");
    expect(body).toContain("| `src/be/new.ts` (not loaded) | 0/2 | 2, 4 |");
    const empty = renderComment({ changed: 0, covered: 0, files: [] }, 6);
    expect(empty).toBe(
      `${MARKER}\nE2E coverage: this PR changes no executable API line (6 lcov file(s) read).\n`,
    );
    expect(renderComment({ error: "no lcov" }, 0)).toContain(
      "Coverage could not be computed: no lcov",
    );
  });
});
